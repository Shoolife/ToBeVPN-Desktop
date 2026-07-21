pub const AUTOSTART_ARG: &str = "--autostart";

pub fn args_contain_autostart<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .any(|argument| argument.as_ref() == AUTOSTART_ARG)
}

#[tauri::command]
pub fn launched_from_autostart() -> bool {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        args_contain_autostart(std::env::args())
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    false
}

#[cfg(target_os = "linux")]
pub fn linux_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_autostart::Builder::new()
        .app_name("ToBeVPN")
        .arg(AUTOSTART_ARG)
        .build()
}

#[tauri::command]
pub fn get_autostart_enabled(_app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        use tauri_plugin_autostart::ManagerExt;
        _app.autolaunch()
            .is_enabled()
            .map_err(|error| format!("Could not read Linux autostart state: {error}"))
    }

    #[cfg(target_os = "windows")]
    {
        windows::is_enabled()
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    Err("Autostart is supported only on Windows and Linux".into())
}

#[tauri::command]
pub fn set_autostart_enabled(_app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = _app.autolaunch();
        if enabled {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(|error| format!("Could not update Linux autostart: {error}"))
    }

    #[cfg(target_os = "windows")]
    {
        if enabled {
            windows::enable()
        } else {
            windows::disable()
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    Err("Autostart is supported only on Windows and Linux".into())
}

#[cfg(target_os = "windows")]
mod windows {
    use super::AUTOSTART_ARG;
    use std::path::PathBuf;
    use windows::core::{Interface, BSTR, HRESULT};
    use windows::Win32::Foundation::{VARIANT_FALSE, VARIANT_TRUE};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::System::TaskScheduler::{
        IExecAction, ILogonTrigger, ITaskFolder, ITaskService, TaskScheduler, TASK_ACTION_EXEC,
        TASK_COMPATIBILITY_V2_4, TASK_CREATE_OR_UPDATE, TASK_INSTANCES_IGNORE_NEW,
        TASK_LOGON_INTERACTIVE_TOKEN, TASK_RUNLEVEL_HIGHEST, TASK_TRIGGER_LOGON,
    };
    use windows::Win32::System::Variant::VARIANT;

    const TASK_NAME: &str = "ToBeVPN Autostart";
    const HRESULT_FILE_NOT_FOUND: HRESULT = HRESULT(0x8007_0002_u32 as i32);
    const SCHED_E_TASK_NOT_FOUND: HRESULT = HRESULT(0x8004_130F_u32 as i32);

    struct ComGuard;

    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    pub fn is_enabled() -> Result<bool, String> {
        run_on_com_thread(|| unsafe {
            with_root_folder(|_, root| match root.GetTask(&BSTR::from(TASK_NAME)) {
                Ok(task) => task
                    .Enabled()
                    .map(|enabled| enabled != VARIANT_FALSE)
                    .map_err(|error| windows_error("Could not read the autostart task", error)),
                Err(error) if is_task_missing(&error) => Ok(false),
                Err(error) => Err(windows_error("Could not find the autostart task", error)),
            })
        })
    }

    pub fn enable() -> Result<(), String> {
        let executable = std::env::current_exe()
            .map_err(|error| format!("Could not locate the ToBeVPN executable: {error}"))?;

        run_on_com_thread(move || unsafe {
            with_root_folder(|service, root| create_task(service, root, executable))
        })
    }

    pub fn disable() -> Result<(), String> {
        run_on_com_thread(|| unsafe {
            with_root_folder(|_, root| match root.DeleteTask(&BSTR::from(TASK_NAME), 0) {
                Ok(()) => Ok(()),
                Err(error) if is_task_missing(&error) => Ok(()),
                Err(error) => Err(windows_error("Could not remove the autostart task", error)),
            })
        })
    }

    fn run_on_com_thread<T, F>(operation: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, String> + Send + 'static,
    {
        std::thread::spawn(move || {
            unsafe {
                CoInitializeEx(None, COINIT_MULTITHREADED)
                    .ok()
                    .map_err(|error| windows_error("Could not initialize Windows COM", error))?;
            }
            let _guard = ComGuard;
            operation()
        })
        .join()
        .map_err(|_| "Windows autostart worker terminated unexpectedly".to_string())?
    }

    unsafe fn with_root_folder<T, F>(operation: F) -> Result<T, String>
    where
        F: FnOnce(&ITaskService, &ITaskFolder) -> Result<T, String>,
    {
        let service: ITaskService = unsafe {
            CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| windows_error("Could not open Windows Task Scheduler", error))?
        };
        let empty = VARIANT::default();
        unsafe {
            service
                .Connect(&empty, &empty, &empty, &empty)
                .map_err(|error| {
                    windows_error("Could not connect to Windows Task Scheduler", error)
                })?;
        }
        let root = unsafe {
            service
                .GetFolder(&BSTR::from("\\"))
                .map_err(|error| windows_error("Could not open the Task Scheduler root", error))?
        };
        operation(&service, &root)
    }

    unsafe fn create_task(
        service: &ITaskService,
        root: &ITaskFolder,
        executable: PathBuf,
    ) -> Result<(), String> {
        let definition = unsafe {
            service
                .NewTask(0)
                .map_err(|error| windows_error("Could not create an autostart task", error))?
        };

        let registration = unsafe {
            definition
                .RegistrationInfo()
                .map_err(|error| windows_error("Could not configure task registration", error))?
        };
        unsafe {
            registration
                .SetDescription(&BSTR::from(
                    "Start ToBeVPN in the system tray after sign-in",
                ))
                .map_err(|error| windows_error("Could not set task description", error))?;
        }

        let user = unsafe {
            service
                .ConnectedUser()
                .map_err(|error| windows_error("Could not determine the Windows user", error))?
                .to_string()
        };
        let domain = unsafe {
            service
                .ConnectedDomain()
                .map_err(|error| windows_error("Could not determine the Windows domain", error))?
                .to_string()
        };
        let user_id = if domain.is_empty() {
            user
        } else {
            format!("{domain}\\{user}")
        };
        let user_id = BSTR::from(user_id);

        let principal = unsafe {
            definition
                .Principal()
                .map_err(|error| windows_error("Could not configure task permissions", error))?
        };
        unsafe {
            principal
                .SetUserId(&user_id)
                .map_err(|error| windows_error("Could not set the task user", error))?;
            principal
                .SetLogonType(TASK_LOGON_INTERACTIVE_TOKEN)
                .map_err(|error| windows_error("Could not set the task logon type", error))?;
            principal
                .SetRunLevel(TASK_RUNLEVEL_HIGHEST)
                .map_err(|error| windows_error("Could not elevate the autostart task", error))?;
        }

        let triggers = unsafe {
            definition
                .Triggers()
                .map_err(|error| windows_error("Could not configure the sign-in trigger", error))?
        };
        let trigger = unsafe {
            triggers
                .Create(TASK_TRIGGER_LOGON)
                .map_err(|error| windows_error("Could not create the sign-in trigger", error))?
        };
        let logon_trigger: ILogonTrigger = trigger
            .cast()
            .map_err(|error| windows_error("Could not configure the sign-in trigger", error))?;
        unsafe {
            logon_trigger
                .SetUserId(&user_id)
                .map_err(|error| windows_error("Could not set the trigger user", error))?;
            logon_trigger
                .SetDelay(&BSTR::from("PT3S"))
                .map_err(|error| windows_error("Could not set the startup delay", error))?;
        }

        let actions = unsafe {
            definition
                .Actions()
                .map_err(|error| windows_error("Could not configure the autostart action", error))?
        };
        let action = unsafe {
            actions
                .Create(TASK_ACTION_EXEC)
                .map_err(|error| windows_error("Could not create the autostart action", error))?
        };
        let exec_action: IExecAction = action
            .cast()
            .map_err(|error| windows_error("Could not configure the autostart action", error))?;
        let executable_text = executable.to_string_lossy().into_owned();
        unsafe {
            exec_action
                .SetPath(&BSTR::from(executable_text))
                .map_err(|error| windows_error("Could not set the autostart executable", error))?;
            exec_action
                .SetArguments(&BSTR::from(AUTOSTART_ARG))
                .map_err(|error| windows_error("Could not set the autostart arguments", error))?;
            if let Some(parent) = executable.parent() {
                exec_action
                    .SetWorkingDirectory(&BSTR::from(parent.to_string_lossy().into_owned()))
                    .map_err(|error| {
                        windows_error("Could not set the task working directory", error)
                    })?;
            }
        }

        let settings = unsafe {
            definition
                .Settings()
                .map_err(|error| windows_error("Could not configure task settings", error))?
        };
        unsafe {
            settings
                .SetEnabled(VARIANT_TRUE)
                .map_err(|error| windows_error("Could not enable the autostart task", error))?;
            settings
                .SetStartWhenAvailable(VARIANT_TRUE)
                .map_err(|error| windows_error("Could not configure delayed startup", error))?;
            settings
                .SetDisallowStartIfOnBatteries(VARIANT_FALSE)
                .map_err(|error| windows_error("Could not configure battery startup", error))?;
            settings
                .SetStopIfGoingOnBatteries(VARIANT_FALSE)
                .map_err(|error| windows_error("Could not configure battery behavior", error))?;
            settings
                .SetRunOnlyIfNetworkAvailable(VARIANT_FALSE)
                .map_err(|error| {
                    windows_error("Could not configure network availability", error)
                })?;
            settings
                .SetMultipleInstances(TASK_INSTANCES_IGNORE_NEW)
                .map_err(|error| windows_error("Could not configure duplicate startup", error))?;
            settings
                .SetExecutionTimeLimit(&BSTR::from("PT0S"))
                .map_err(|error| windows_error("Could not remove the task time limit", error))?;
            settings
                .SetCompatibility(TASK_COMPATIBILITY_V2_4)
                .map_err(|error| windows_error("Could not set task compatibility", error))?;
        }

        let empty = VARIANT::default();
        unsafe {
            root.RegisterTaskDefinition(
                &BSTR::from(TASK_NAME),
                &definition,
                TASK_CREATE_OR_UPDATE.0,
                &empty,
                &empty,
                TASK_LOGON_INTERACTIVE_TOKEN,
                &empty,
            )
            .map_err(|error| {
                windows_error(
                    "Could not register the elevated autostart task; run ToBeVPN as Administrator",
                    error,
                )
            })?;
        }
        Ok(())
    }

    fn is_task_missing(error: &windows::core::Error) -> bool {
        matches!(
            error.code(),
            HRESULT_FILE_NOT_FOUND | SCHED_E_TASK_NOT_FOUND
        )
    }

    fn windows_error(context: &str, error: windows::core::Error) -> String {
        format!("{context}: {error}")
    }
}

#[cfg(test)]
mod tests {
    use super::args_contain_autostart;

    #[test]
    fn detects_exact_autostart_argument() {
        assert!(args_contain_autostart(["ToBeVPN", "--autostart"]));
        assert!(!args_contain_autostart(["ToBeVPN", "--autostart=true"]));
        assert!(!args_contain_autostart(["ToBeVPN"]));
    }
}
