# v3.17.1 upstream merge — test coverage debt (2026-10-31)

Upstream v3.17.1 retired its app-unit suite ("\u0410pp 业务单测已退役") and
rewrote the affected runtimes. The fork restored all 1938 deleted test files,
kept 1787 that pass against the merged tree, and reverted 151 suites whose
mock contracts pin the pre-3.17.1 module surface (runtime-behavior drift,
not fork regressions — fork-owned suites in packages/ui/src/spec-document,
presentation/popout/windows suites all pass). These need re-authoring against
the v3.17.1 internals before their coverage returns; they remain recoverable
from fork history (git log -- <path> before merge 3.17.1).

## Quarantined upstream engineering tests (Windows env, not product)

- packages/desktop/test/telemetryFieldContract.test.ts — git child process fails
  on NUL device inside the vitest fork pool (Windows-specific spawn/stdio);
- packages/desktop/scripts/gen-ui-runtime-assets.test.ts — local runtime asset hash
  behind the pin; the release build prepare step refreshes assets.

## Reverted stale suites (151)

- packages/client/test/webRemoteControlRelayProtocol.test.ts
- packages/desktop/test/appARMSBootstrap.test.ts
- packages/desktop/test/autoUpdaterReadyState.test.ts
- packages/desktop/test/browserControlMainBridge.test.ts
- packages/desktop/test/browserGuestManager.test.ts
- packages/desktop/test/desktopWindowChrome.test.ts
- packages/desktop/test/fileApplications.test.ts
- packages/desktop/test/hostRemoteStartupIntegration.test.ts
- packages/desktop/test/lintStagedConfig.test.ts
- packages/desktop/test/remoteWorkspaceBindBridge.test.ts
- packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts
- packages/desktop/test/windowHostAttachmentRpcPolicy.test.ts
- packages/desktop/test/windowProjectDirectoryAttachment.test.ts
- packages/desktop/test/windowTopicResourceRelay.test.ts
- packages/provider-node/test/bundled-config-replacement.test.ts
- packages/provider-node/test/chatgpt-builtin-provider.test.ts
- packages/provider-node/test/mimo-templates.test.ts
- packages/provider-node/test/opencode-go.test.ts
- packages/provider-node/test/zcode-builtin-download.test.ts
- packages/provider-node/test/zcode-builtin-integrity.test.ts
- packages/server/test/dockerBackendDockerCommand.test.ts
- packages/server/test/remoteAssetInstaller.test.ts
- packages/server/test/serverInfoHttp.test.ts
- packages/server/test/sourceServerTransportAdapter.test.ts
- packages/server/test/stdioDesktopPresentationSurface.test.ts
- packages/server/test/wslBackend.test.ts
- packages/services/test/accountProjectTokenRefresh.test.ts
- packages/services/test/controllerRemoteIdentityMigration.test.ts
- packages/services/test/conversationSharePublicProjection.test.ts
- packages/services/test/conversationShareService.test.ts
- packages/services/test/localServicesRemoteAuthority.test.ts
- packages/services/test/mcpSyncService.test.ts
- packages/services/test/offPeakE2eIntegration.test.ts
- packages/services/test/offPeakServerClient.test.ts
- packages/services/test/offPeakTaskService.test.ts
- packages/services/test/officialMcpAuthRemoteRouting.test.ts
- packages/services/test/pluginSyncService.test.ts
- packages/services/test/providerBuiltinRefreshFailure.test.ts
- packages/services/test/skillSyncService.test.ts
- packages/services/test/subagentRuntimeConfigWatcher.test.ts
- packages/services/test/taskIndexRepoWorkspaceIdentity.test.ts
- packages/services/test/telemetryPrivacy.test.ts
- packages/services/test/telemetryService.test.ts
- packages/services/test/zcodeAgentProcessManager.test.ts
- packages/services/test/zcodeAgentService.dynamicWorkflowPolicy.test.ts
- packages/services/test/zcodeAgentService.mcpTelemetry.test.ts
- packages/services/test/zcodeAgentService.offPeakToolPolicy.test.ts
- packages/services/test/zcodeAgentService.providerRegistry.test.ts
- packages/services/test/zcodeAgentService.resourceTelemetry.test.ts
- packages/services/test/zcodeAgentService.savedWorkflows.test.ts
- packages/services/test/zcodeAgentService.test.ts
- packages/services/test/zcodeAgentService.toolExecResourceTelemetry.test.ts
- packages/services/test/zcodeAgentService.v4.test.ts
- packages/services/test/zcodeAgentService.workspaceHookTrust.test.ts
- packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts
- packages/shared/test/backgroundTaskNotifications.test.ts
- packages/shared/test/conversationShareContent.test.ts
- packages/shared/test/localTtft.test.ts
- packages/shared/test/telemetry.test.ts
- packages/shared/test/telemetryPrivacy.test.ts
- packages/ui/test/agentV4ConnectionTransports.test.ts
- packages/ui/test/appTelemetryPrivacy.test.ts
- packages/ui/test/chatErrorBannerI18n.test.ts
- packages/ui/test/chatPlaceholder.test.ts
- packages/ui/test/highspeed/highspeedTurnStore.test.ts
- packages/ui/test/highspeed/highspeedVisibilityRefresh.test.ts
- packages/ui/test/highspeed/sessionPaneHighspeedActivation.test.ts
- packages/ui/test/hooksSection.test.ts
- packages/ui/test/hooksSectionWorkspaceHookTrustNotice.test.ts
- packages/ui/test/localTtft.test.ts
- packages/ui/test/markdownImageLoadingState.test.ts
- packages/ui/test/mcpSettingsSectionStatusList.test.ts
- packages/ui/test/mcpStore.test.ts
- packages/ui/test/modelProviderModelRowEditor.test.ts
- packages/ui/test/nodeReplToolCallBlockInteraction.test.ts
- packages/ui/test/permissionDialogFocus.test.ts
- packages/ui/test/pluginManagementProjectionSync.test.ts
- packages/ui/test/pluginReferenceIconProjection.test.ts
- packages/ui/test/pluginStoreCardRestorable.test.ts
- packages/ui/test/pluginStoreTryMentionCommit.test.ts
- packages/ui/test/previewCardActions.test.ts
- packages/ui/test/projectAutoArchiveSelection.test.ts
- packages/ui/test/projectComposerMenu.test.ts
- packages/ui/test/projectFirstSubmitVisibility.test.ts
- packages/ui/test/projectRemoteSync.test.ts
- packages/ui/test/projectSidebarNavigation.test.ts
- packages/ui/test/projectTreeRemoteRefresh.test.ts
- packages/ui/test/projectTreeWindowDirectory.test.ts
- packages/ui/test/reactStableReferences.test.ts
- packages/ui/test/remoteAccessibility.test.ts
- packages/ui/test/remoteConnectionDialogContentLayout.test.ts
- packages/ui/test/remoteConnectionDirectoryNavigation.test.ts
- packages/ui/test/remoteConnectionInstallProgress.test.ts
- packages/ui/test/remoteConnectionPlaceholderValues.test.ts
- packages/ui/test/remoteConnectionPresentationComponents.test.ts
- packages/ui/test/remoteI18nPlaceholderValues.test.ts
- packages/ui/test/remoteMcpSyncDialog.test.ts
- packages/ui/test/remotePluginSyncDialog.test.ts
- packages/ui/test/remoteSkillSyncDialog.test.ts
- packages/ui/test/remoteSyncActions.test.ts
- packages/ui/test/remoteUiDesignTokenConformance.test.ts
- packages/ui/test/rootNewTaskWorkbenchContext.test.ts
- packages/ui/test/rootUpdateReadyOverlay.test.ts
- packages/ui/test/settingsMachine.test.ts
- packages/ui/test/settingsPageConfig.test.ts
- packages/ui/test/skillsSection.test.ts
- packages/ui/test/slashCommandHelpers.test.ts
- packages/ui/test/sourceServerManagementPanel.test.ts
- packages/ui/test/subagentsSection.test.ts
- packages/ui/test/terminalPanelState.test.ts
- packages/ui/test/topicPreparationRenderUnits.test.ts
- packages/ui/test/useSavedWorkflowLauncher.test.ts
- packages/ui/test/useSavedWorkflowPromote.test.ts
- packages/ui/test/v4AssistantPreviewCards.test.ts
- packages/ui/test/v4ConversationComposerPromptHistory.test.ts
- packages/ui/test/v4ConversationRuntimeRecycleSelfHeal.test.ts
- packages/ui/test/v4ConversationTelemetrySupervisor.test.ts
- packages/ui/test/v4ConversationTimelineHiddenGeometry.test.ts
- packages/ui/test/v4ConversationTimelineLiveTail.test.ts
- packages/ui/test/v4ConversationTimelinePresentationSuspension.test.ts
- packages/ui/test/v4ConversationTimelineScrollMemory.test.ts
- packages/ui/test/v4ConversationTimelineScrollbarGutter.test.ts
- packages/ui/test/v4ConversationTurnGroup.test.ts
- packages/ui/test/v4ConversationTurnRenderUnits.test.ts
- packages/ui/test/v4HiddenRevealWorkCounts.measurement.test.ts
- packages/ui/test/v4PendingCommandRegistry.test.ts
- packages/ui/test/v4ResyncNotOwnedEvictionRace.test.ts
- packages/ui/test/v4SessionPaneComposerContinuity.test.ts
- packages/ui/test/v4SessionPaneEditUserQuery.test.ts
- packages/ui/test/v4SessionPaneErrorBanner.test.ts
- packages/ui/test/v4SessionPaneFollowupModeSettingsSync.test.ts
- packages/ui/test/v4SessionPaneLayoutParity.test.ts
- packages/ui/test/v4SessionPaneModelSwitchRecovery.test.ts
- packages/ui/test/v4SessionPanePresentationSuspension.test.ts
- packages/ui/test/v4SessionPaneReadOnly.test.ts
- packages/ui/test/v4SessionQuotaBannerState.test.ts
- packages/ui/test/v4WebElementContextAttachment.test.ts
- packages/ui/test/workflowArtifactSidePane.test.ts
- packages/ui/test/workspaceConnectionRegistry.test.ts
- packages/ui/test/workspaceHeaderTitleSection.test.ts
- packages/ui/test/workspaceHelpMenuButton.test.ts
- packages/ui/test/workspaceHookPendingBanner.test.ts
- packages/ui/test/workspaceStartupRpcEffects.test.ts
- packages/web/test/homeOnlyWebRemoteControlServices.test.ts
- packages/web/test/webRemoteControlEntry.test.ts
- packages/zcode-server-cli/test/componentCache.test.ts
- packages/zcode-server-cli/test/lock.test.ts
- packages/zcode-server-cli/test/releaseInstaller.test.ts
- packages/zcode-server-cli/test/remoteAssetRelease.test.ts
- packages/zcode-server-cli/test/serviceManager.test.ts
- packages/zcode-server-cli/test/supervisor.test.ts
