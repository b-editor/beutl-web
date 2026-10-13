export const ERROR_NOW = new Date("2026-10-13T01:44:28Z");
export function logEntry(
  secondsAgo: number,
  fields: Record<string, string> = {},
  template = "An exception occurred while drawing the frame. frame={Frame}.",
) {
  return [
    String(BigInt(ERROR_NOW.getTime() - secondsAgo * 1000) * BigInt(1_000_000)),
    template,
    {
      structuredMetadata: {
        severity_text: "Error",
        detected_level: "error",
        scope_name: "Beutl.ViewModels.PlayerViewModel",
        os_name: "Windows",
        service_version: "2.0.0-preview.8",
        exception_type: "System.InvalidOperationException",
        exception_message: "The backward bounds mapping returned an invalid rectangle.",
        exception_stacktrace:
          "System.InvalidOperationException: The backward bounds mapping returned an invalid rectangle.\n   at Beutl.Graphics.Rendering.Requests.TargetDependencyLowerer.Builder.LowerScopeWrapper()\n   at Beutl.ViewModels.PlayerViewModel.Render()",
        Frame: "128",
        ...fields,
      },
    },
  ];
}

export function logResponse(values: unknown[][] = []) {
  return {
    status: "success",
    data: {
      resultType: "streams",
      result: [
        { stream: { service_name: "Beutl", service_instance_id: "private-instance" }, values },
      ],
    },
  };
}

export const errorLogFixture = logResponse([
  logEntry(180, { severity_text: "Critical", detected_level: "critical" }),
  logEntry(60, { Frame: "129", os_name: "Linux" }),
  logEntry(
    300,
    {
      scope_name: "Beutl.Services.StartupTasks.LoadInstalledExtensionTask",
      exception_type: "System.TypeLoadException",
      exception_message: "Could not load type 'FluentAvalonia.UI.Controls.ContentDialog'.",
      exception_stacktrace:
        "System.TypeLoadException: Could not load type 'FluentAvalonia.UI.Controls.ContentDialog'.\n   at System.Reflection.RuntimeAssembly.GetExportedTypes()\n   at Beutl.Api.Services.PackageManager.Load()",
      PackageName: "Example.Extension",
      os_name: "arch",
    },
    "Failed to load package: {PackageName}",
  ),
  logEntry(
    240,
    {
      exception_type: "",
      exception_message: "",
      exception_stacktrace: "",
      scope_name: "FFmpegWorker",
      Channel: "stdout",
      os_name: "org.freedesktop.platform",
      Message:
        "FFmpeg libraries not found.\nBeutl.FFmpegIpc.FFmpegLibrariesNotFoundException: FFmpeg libraries not found.\n   at Beutl.FFmpegWorker.FFmpegLoaderWorker.GetRootPath()\n   at Beutl.FFmpegWorker.Program.Main(String[] args)",
    },
    "{Channel} {Message}",
  ),
  logEntry(
    120,
    {
      exception_type: "",
      exception_message: "",
      exception_stacktrace: "",
      scope_name: "Beutl.Editor.Components.TimelineTab.ViewModels.TimelineTabViewModel",
      FailureId: "unsupported-media",
    },
    "Failed to add a timeline element: {FailureId}",
  ),
]);
