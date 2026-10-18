#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    if pandacode_lib::handle_usage_keychain_helper() {
        return;
    }
    pandacode_lib::run()
}
