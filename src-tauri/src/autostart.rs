pub const AUTOSTART_ARG: &str = "--autostart";

#[cfg(all(target_os = "windows", not(debug_assertions)))]
pub(crate) fn ensure_protected_runtime_path(path: &std::path::Path) -> Result<(), String> {
    windows::ensure_protected_runtime_path(path)
}

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
    #[cfg(not(debug_assertions))]
    use std::path::Path;
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
    #[cfg(not(debug_assertions))]
    use windows::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{
            FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
        },
    };

    const LEGACY_TASK_NAME: &str = "ToBeVPN Autostart";
    const TASK_NAME_PREFIX: &str = "ToBeVPN Autostart";
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
            with_root_folder(|service, root| {
                let user_id = connected_user_id(service)?;
                let task_name = user_task_name(&user_id);
                match root.GetTask(&BSTR::from(task_name)) {
                    Ok(task) => task
                        .Enabled()
                        .map(|enabled| enabled != VARIANT_FALSE)
                        .map_err(|error| windows_error("Could not read the autostart task", error)),
                    Err(error) if is_task_missing(&error) => {
                        if legacy_task_belongs_to(root, &user_id)? {
                            root.GetTask(&BSTR::from(LEGACY_TASK_NAME))
                                .and_then(|task| task.Enabled())
                                .map(|enabled| enabled != VARIANT_FALSE)
                                .map_err(|error| {
                                    windows_error("Could not read the legacy autostart task", error)
                                })
                        } else {
                            Ok(false)
                        }
                    }
                    Err(error) => Err(windows_error("Could not find the autostart task", error)),
                }
            })
        })
    }

    pub fn enable() -> Result<(), String> {
        let executable = std::env::current_exe()
            .map_err(|error| format!("Could not locate the ToBeVPN executable: {error}"))?;
        // A highest-privilege scheduled task pointing into a user-writable
        // directory becomes a persistent local privilege escalation as soon
        // as that executable is replaced. Production builds are canonical
        // only under Program Files\ToBeVPN; refuse legacy/copied locations.
        #[cfg(not(debug_assertions))]
        ensure_protected_install_location(&executable)?;

        run_on_com_thread(move || unsafe {
            with_root_folder(|service, root| create_task(service, root, executable))
        })
    }

    #[cfg(not(debug_assertions))]
    fn ensure_protected_install_location(executable: &Path) -> Result<(), String> {
        let executable = executable
            .canonicalize()
            .map_err(|error| format!("Could not resolve the ToBeVPN executable path: {error}"))?;
        let parent = executable
            .parent()
            .ok_or_else(|| "The ToBeVPN executable has no parent directory".to_string())?;

        for expected in protected_install_roots() {
            if paths_equal_ignoring_ascii_case(parent, &expected) {
                return Ok(());
            }
        }

        Err(
            "Autostart is unavailable because ToBeVPN is not installed in Program Files\\ToBeVPN"
                .into(),
        )
    }

    #[cfg(not(debug_assertions))]
    pub(super) fn ensure_protected_runtime_path(path: &Path) -> Result<(), String> {
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("Could not resolve protected runtime path: {error}"))?;
        if protected_install_roots().iter().any(|root| {
            canonical
                .ancestors()
                .any(|ancestor| paths_equal_ignoring_ascii_case(ancestor, root))
        }) {
            return Ok(());
        }
        Err(format!(
            "Refusing elevated access to a runtime file outside Program Files\\ToBeVPN: {}",
            canonical.display()
        ))
    }

    #[cfg(not(debug_assertions))]
    fn protected_install_roots() -> Vec<PathBuf> {
        [&FOLDERID_ProgramFiles, &FOLDERID_ProgramFilesX86]
            .into_iter()
            .filter_map(|folder_id| known_folder_path(folder_id).ok())
            .filter_map(|program_files| program_files.join("ToBeVPN").canonicalize().ok())
            .collect()
    }

    #[cfg(not(debug_assertions))]
    fn paths_equal_ignoring_ascii_case(left: &Path, right: &Path) -> bool {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }

    #[cfg(not(debug_assertions))]
    fn known_folder_path(folder_id: &windows::core::GUID) -> Result<PathBuf, String> {
        let raw = unsafe { SHGetKnownFolderPath(folder_id, KF_FLAG_DEFAULT, None) }
            .map_err(|error| windows_error("Could not resolve Program Files", error))?;
        let decoded = unsafe { raw.to_string() };
        unsafe { CoTaskMemFree(Some(raw.0.cast())) };
        decoded
            .map(PathBuf::from)
            .map_err(|_| "Program Files contains invalid UTF-16".to_string())
    }

    pub fn disable() -> Result<(), String> {
        run_on_com_thread(|| unsafe {
            with_root_folder(|service, root| {
                let user_id = connected_user_id(service)?;
                let task_name = user_task_name(&user_id);
                delete_task_if_present(root, &task_name)?;
                if legacy_task_belongs_to(root, &user_id)? {
                    delete_task_if_present(root, LEGACY_TASK_NAME)?;
                }
                Ok(())
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

        let user_id_text = unsafe { connected_user_id(service)? };
        let task_name = user_task_name(&user_id_text);
        let user_id = BSTR::from(&user_id_text);

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
                &BSTR::from(task_name),
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
        if unsafe { legacy_task_belongs_to(root, &user_id_text)? } {
            unsafe { delete_task_if_present(root, LEGACY_TASK_NAME)? };
        }
        Ok(())
    }

    unsafe fn connected_user_id(service: &ITaskService) -> Result<String, String> {
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
        if user.trim().is_empty() {
            return Err("Could not determine the Windows user".into());
        }
        Ok(if domain.is_empty() {
            user
        } else {
            format!("{domain}\\{user}")
        })
    }

    fn user_task_name(user_id: &str) -> String {
        // The root Task Scheduler folder is machine-wide. A fixed name lets
        // the last administrator overwrite another user's logon task. Use a
        // deterministic, non-reversible suffix while keeping the task easy to
        // identify during uninstall.
        let mut hash = 0xcbf2_9ce4_8422_2325_u64;
        for byte in user_id.to_lowercase().as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{TASK_NAME_PREFIX} {hash:016x}")
    }

    unsafe fn legacy_task_belongs_to(
        root: &ITaskFolder,
        expected_user_id: &str,
    ) -> Result<bool, String> {
        let task = match unsafe { root.GetTask(&BSTR::from(LEGACY_TASK_NAME)) } {
            Ok(task) => task,
            Err(error) if is_task_missing(&error) => return Ok(false),
            Err(error) => {
                return Err(windows_error(
                    "Could not inspect the legacy autostart task",
                    error,
                ))
            }
        };
        let definition = unsafe { task.Definition() }
            .map_err(|error| windows_error("Could not inspect the legacy task", error))?;
        let principal = unsafe { definition.Principal() }
            .map_err(|error| windows_error("Could not inspect the legacy task user", error))?;
        let mut task_user = BSTR::new();
        unsafe { principal.UserId(&mut task_user) }
            .map_err(|error| windows_error("Could not read the legacy task user", error))?;
        Ok(task_user.to_string().eq_ignore_ascii_case(expected_user_id))
    }

    unsafe fn delete_task_if_present(root: &ITaskFolder, task_name: &str) -> Result<(), String> {
        match unsafe { root.DeleteTask(&BSTR::from(task_name), 0) } {
            Ok(()) => Ok(()),
            Err(error) if is_task_missing(&error) => Ok(()),
            Err(error) => Err(windows_error("Could not remove the autostart task", error)),
        }
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
