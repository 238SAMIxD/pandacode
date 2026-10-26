// Preview data for scoped pairing (src-tauri/src/remote/grants.rs).
export function previewGrants(command: string, args: Record<string, any>): unknown {
  void command; void args;
  return command === 'remote_device_grants' ? [] : undefined;
}
