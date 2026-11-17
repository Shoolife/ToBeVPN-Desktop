//! For the build for older systems (feature `webkit-4-0`,
//! packaging/legacy/build.sh): linked against WebKitGTK API 4.0, libsoup 2
//! and GLib 2.58, with bindings made for libsoup 3 and a newer GLib. The few
//! functions they call that those libraries lack are provided here.

use gtk::glib::ffi::{GQuark, GSource, GSourceFuncs};
use std::ffi::{c_char, c_void};
use std::sync::Mutex;

extern "C" {
    fn soup_message_headers_get_type() -> usize;
    fn soup_message_headers_free(headers: *mut c_void);
    fn g_boxed_copy(boxed_type: usize, src: *const c_void) -> *mut c_void;
    fn g_quark_from_static_string(string: *const c_char) -> GQuark;
}

/// libsoup 3's reference to SoupMessageHeaders. In libsoup 2 the boxed
/// type's copy function is that reference (the headers are shared).
///
/// # Safety
/// `headers` is a valid SoupMessageHeaders.
#[no_mangle]
pub unsafe extern "C" fn soup_message_headers_ref(headers: *mut c_void) -> *mut c_void {
    g_boxed_copy(soup_message_headers_get_type(), headers)
}

/// libsoup 3's release of a reference; in libsoup 2 the same reference-counted
/// release is soup_message_headers_free.
///
/// # Safety
/// `headers` is a SoupMessageHeaders the caller holds a reference to.
#[no_mangle]
pub unsafe extern "C" fn soup_message_headers_unref(headers: *mut c_void) {
    soup_message_headers_free(headers);
}

/// GLib 2.66's error domain of GUri, as GLib defines it.
#[no_mangle]
pub extern "C" fn g_uri_error_quark() -> GQuark {
    unsafe { g_quark_from_static_string(c"g-uri-quark".as_ptr()) }
}

type SourceDispose = unsafe extern "C" fn(*mut GSource);
type SourceFinalize = unsafe extern "C" fn(*mut GSource);

/// Per source: its dispose function and the finalize one it replaced.
static DISPOSE: Mutex<Vec<(usize, Option<SourceDispose>, Option<SourceFinalize>)>> =
    Mutex::new(Vec::new());

unsafe extern "C" fn dispose_then_finalize(source: *mut GSource) {
    let entry = {
        let mut sources = DISPOSE.lock().unwrap_or_else(|e| e.into_inner());
        let at = sources.iter().position(|(s, _, _)| *s == source as usize);
        at.map(|at| sources.swap_remove(at))
    };
    if let Some((_, dispose, finalize)) = entry {
        if let Some(dispose) = dispose {
            dispose(source);
        }
        if let Some(finalize) = finalize {
            finalize(source);
        }
    }
}

/// GLib 2.64's dispose function of a GSource: GLib runs it once the last
/// reference is dropped, just before finalize. GLib 2.58 has no such hook,
/// so it runs from the source's own finalize, the step right after. Only
/// glib-rs's main context channels set one, each with source functions of
/// its own (so replacing their finalize touches no other source).
///
/// # Safety
/// `source` is a valid GSource whose GSourceFuncs belong to it alone.
#[no_mangle]
pub unsafe extern "C" fn g_source_set_dispose_function(
    source: *mut GSource,
    dispose: Option<SourceDispose>,
) {
    let funcs = (*source).source_funcs as *mut GSourceFuncs;
    let mut sources = DISPOSE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(at) = sources.iter().position(|(s, _, _)| *s == source as usize) {
        sources[at].1 = dispose;
        return;
    }
    sources.push((source as usize, dispose, (*funcs).finalize));
    (*funcs).finalize = Some(dispose_then_finalize);
}
