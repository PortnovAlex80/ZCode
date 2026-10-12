/** Public renderer bootstrap surface: excludes business roots and editor screens. */
export { AppErrorBoundary } from "./ErrorBoundary.js";
export {
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
} from "./store/remoteWorkspaceSessionStore.js";
export { createRemoteWorkspaceDisconnectedError } from "./lib/remoteWorkspaceServiceError.js";
export { ZCodeIntlProvider } from "./i18n/index.js";
export { playTaskNotificationSound } from "./lib/taskNotificationSound.js";
export { installDocumentHiddenMotionPause } from "./lib/documentHiddenMotionPause.js";
export { RendererUserActionTelemetry, setUserActionTelemetry } from "./lib/userActionTelemetry.js";
export { setReactErrorArmsReporter } from "./lib/reactErrorArmsTelemetry.js";
export { recordArmsCustomEventForE2E } from "./lib/armsCustomEventObservability.js";
export { setStreamClientId } from "./lib/streamClientId.js";
export { GlobalDatabaseStartupLoading } from "./root/GlobalDatabaseStartupLoading.js";
export { LocalTtftObserver, setLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
