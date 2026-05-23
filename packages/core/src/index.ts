// v0.16 Tool Result Envelope
export {
  TOOL_RESULT_ENVELOPE_VERSION,
  makeSuccessEnvelope,
  makeFailureEnvelope,
  type ToolResultEnvelope,
  type ToolResultSuccess,
  type ToolResultFailure,
  type ToolResultRange,
  type ToolResultSize,
  type ToolResultNext,
  type ToolResultEnvelopeVersion,
} from "./tools/envelope.js";

// v0.16 Cursor encode/decode + per-tool cursor types
export {
  encodeCursor,
  decodeCursor,
  CursorDecodeError,
  type ReadFileCursor,
  type ListFilesCursor,
  type SearchFilesCursor,
  type AnyCursor,
} from "./tools/cursor.js";

// v0.16 Cursor error envelope helpers
export { cursorInvalidEnvelope, staleCursorEnvelope } from "./tools/envelopeErrors.js";

// Plugin schema and loader
export {
  PluginManifestSchema,
  PluginComponentsSchema,
  ModeDefinitionSchema,
  TARGETS,
  FREEDOM_LEVELS,
  type PluginManifest,
  type PluginComponents,
  type ModeDefinition,
  type Target,
  type FreedomLevel,
} from "./plugin/PluginManifest.js";
export {
  validatePluginManifest,
  type ValidationResult,
  type ValidationIssue,
  type IssueSeverity,
  type ValidatorOptions,
} from "./plugin/PluginValidator.js";
export {
  loadPluginFromDirectory,
  PluginLoadError,
  PLUGIN_MANIFEST_FILENAME,
  type LoadPluginOptions,
} from "./plugin/PluginLoader.js";
export {
  readRegistry,
  writeRegistry,
  upsertEntry,
  removeEntry,
  RegistryFileSchema,
  REGISTRY_FILENAME,
  TIERKIT_DIR,
  type RegistryFile,
  type RegistryEntry,
} from "./plugin/PluginRegistry.js";

// Commands
export {
  CommandDefinitionSchema,
  COMMAND_CATEGORIES,
  type CommandDefinition,
  type CommandCategory,
} from "./command/CommandDefinition.js";
export { renderCommandTemplate, type RenderContext } from "./command/CommandTemplateRenderer.js";

// Model
export {
  MODEL_TIERS,
  ModelProfileSchema,
  ModelProfileMapSchema,
  ModelPolicySchema,
  ModelCostSchema,
  type ModelTier,
  type ModelProfile,
  type ModelProfileMap,
  type ModelPolicy,
  type ModelCost,
  // v0.12 additions:
  PAYMENT_MODELS,
  type PaymentModel,
  effectivePaymentModel,
} from "./model/ModelProfile.js";
export {
  canonicalIdentity,
  isProfileDisabled,
} from "./model/profileIdentity.js";
export {
  scoreRisk,
  tierForScore,
  DEFAULT_RISK_THRESHOLDS,
  type RiskInput,
  type RiskScore,
  type RiskThresholds,
} from "./model/RiskScorer.js";
export { decideRoute, type RouteDecision, type ExplainRouteInput } from "./model/ModelRouter.js";

// Security
export {
  PERMISSIONS,
  HIGH_RISK_PERMISSIONS,
  PermissionFlagsSchema,
  listGrantedPermissions,
  listHighRiskGranted,
  type TierkitPermission,
  type PermissionFlags,
} from "./security/Permission.js";
export {
  redactSecrets,
  getDefaultRedactionRules,
  type RedactionRule,
  type RedactionResult,
} from "./security/SecretRedactor.js";
export { DEFAULT_REDACTION_RULES } from "./security/redactionRules.js";
export {
  isSensitivePath,
  matchSensitive,
  describeMatch,
  DEFAULT_SENSITIVE_PATTERNS,
  type SensitiveMatch,
} from "./security/sensitiveFiles.js";
export {
  classifyCommand,
  DEFAULT_DANGER_RULES,
  type DangerSeverity,
  type DangerRule,
  type CommandClassification,
} from "./security/dangerousCommands.js";
export { createSecretsStore } from "./security/SecretsStore.js";
export type { SecretsStore, SecretsStoreEntry, SecretsStoreListOptions } from "./security/SecretsStore.js";

// Adapter
export type {
  TierkitAdapter,
  LoadedPlugin,
  AdapterExportInput,
} from "./adapter/TierkitAdapter.js";
export type { ExportFile, ExportResult, ExportWarning } from "./adapter/ExportResult.js";
export { GenericMarkdownAdapter } from "./adapter/GenericMarkdownAdapter.js";

// Config
export {
  TierkitConfigSchema,
  RoutingPolicySchema,
  RiskThresholdsSchema,
  SecurityPolicySchema,
  BudgetPolicySchema,
  PerProfileBudgetSchema,
  CONFIG_FILENAME,
  type TierkitConfig,
  type PerProfileBudget,
} from "./config/TierkitConfig.js";
export {
  loadConfig,
  defaultConfig,
  userConfigPath,
  type ConfigLoadResult,
  type ConfigSource,
  type LoadConfigOptions,
} from "./config/loadConfig.js";
export { DEFAULT_MODEL_PROFILES, DEFAULT_PROFILE_IDS } from "./config/defaultProfiles.js";
export { migrateLegacyEnabledField } from "./config/migrateLegacyEnabledField.js";
export { migrateCanonicalDuplicates } from "./config/migrateCanonicalDuplicates.js";
export {
  discoverOllamaProfiles,
  _clearDiscoveryCacheForTests,
  type DiscoverOptions,
} from "./model/discoverOllamaProfiles.js";
export {
  addProfile,
  removeProfile,
  ProfileCrudError,
  type ProfileScope,
  type AddProfileInput,
  type RemoveProfileInput,
  type ProfileCrudResult,
} from "./usecases/profileCrud.js";
export {
  connectTool,
  listConnections,
  type ConnectableTool,
  type ConnectToolInput,
  type ConnectToolResult,
  type ConnectionStatus,
} from "./usecases/connectTool.js";
export {
  syncPlugins,
  detectConnectedTools,
  type SyncPluginsInput,
  type SyncPluginsResult,
} from "./usecases/syncPlugins.js";
export {
  pluginNew,
  PluginNewError,
  type PluginNewInput,
  type PluginNewResult,
} from "./usecases/pluginNew.js";

// Filesystem safety
export { resolveUnder, isWithin, PathTraversalError } from "./fs/safePath.js";

// Base error
export { TierkitError } from "./errors/TierkitError.js";

// Usecases
export {
  validatePlugin,
  type ValidatePluginInput,
  type ValidatePluginResult,
} from "./usecases/validatePlugin.js";
export {
  installPlugin,
  PluginInstallError,
  PLUGIN_STORE_SUBDIR,
  type InstallPluginInput,
  type InstallPluginResult,
} from "./usecases/installPlugin.js";
export {
  generatePlugin,
  PluginGenerateError,
  type GeneratePluginInput,
  type GeneratePluginResult,
  type GeneratedRule,
} from "./usecases/generatePlugin.js";
export { listPlugins, type ListPluginsInput, type ListPluginsResult } from "./usecases/listPlugins.js";
export {
  exportTarget,
  type ExportTargetInput,
  type ExportTargetResult,
} from "./usecases/exportTarget.js";
export { initProject, type InitProjectInput, type InitProjectResult } from "./usecases/initProject.js";
// v0.5 usecases: models / route / config
export {
  listModels,
  type ListModelsInput,
  type ListModelsResult,
  type ModelListEntry,
} from "./usecases/listModels.js";
export {
  testModel,
  TestModelError,
  type TestModelInput,
  type TestModelResult,
} from "./usecases/testModel.js";
export {
  explainRoute as explainRouteUsecase,
  type ExplainRouteUsecaseInput,
  type ExplainRouteUsecaseResult,
} from "./usecases/explainRoute.js";
export {
  showConfig,
  type ShowConfigInput,
  type ShowConfigResult,
} from "./usecases/showConfig.js";

// v0.6 security check usecases
export {
  checkRedact,
  type CheckRedactInput,
  type CheckRedactResult,
} from "./usecases/checkRedact.js";
export {
  checkCommand,
  type CheckCommandInput,
  type CheckCommandResult,
} from "./usecases/checkCommand.js";
export {
  checkPath,
  type CheckPathInput,
  type CheckPathResult,
} from "./usecases/checkPath.js";

// v1.0 runtime
export { startServer, type ServerOptions, type RunningServer } from "./runtime/Server.js";
export {
  type CompareSsePhase,
  type CompareSseSide,
  type CompareSseEvent,
} from "./runtime/compareSseEvents.js";
export {
  appendUsage,
  readUsage,
  summarizeUsage,
  estimateCost,
  aggregateByProfile,
  type UsageRecord,
  type UsageSummary,
  type ProfileUsageEntry,
} from "./runtime/usageLog.js";
export { computeRoutingSavings, type RoutingSavingsSummary } from "./runtime/routingSavings.js";
export { checkBudget, type BudgetCheckResult, type BudgetStatus, type BudgetPolicy } from "./runtime/budget.js";
export {
  checkPerProfileBudget,
  type CheckPerProfileBudgetInput,
  type CheckPerProfileBudgetResult,
  type ProfileUsageSnapshot,
} from "./runtime/checkPerProfileBudget.js";
export {
  executeLlmCall,
  type LlmCallRequest,
  type LlmCallResult,
  type LlmCallOk,
  type LlmCallFail,
  type LlmCallContext,
} from "./runtime/proxy/llmCall.js";
export type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatOk,
  ChatFail,
  ChatUsage,
  StreamEvent,
} from "./model/providers/chatTypes.js";

// v1.0 lifecycle usecases
export {
  enablePlugin,
  disablePlugin,
  removePlugin,
  PluginLifecycleError,
  type PluginLifecycleInput,
  type PluginLifecycleResult,
} from "./usecases/pluginLifecycle.js";
export {
  startRuntime,
  stopRuntime,
  runtimeStatus,
  RuntimeError,
  type RuntimeStartInput,
  type RuntimeStartResult,
  type RuntimeStopInput,
  type RuntimeStopResult,
  type RuntimeStatusInput,
  type RuntimeStatusResult,
} from "./usecases/runtimeLifecycle.js";
export { usage, type UsageInput, type UsageResult } from "./usecases/usage.js";

// v1.1 — task context + runRoute
export {
  buildTaskContext,
  type BuildTaskContextInput,
  type BuildTaskContextResult,
  type RunMode,
} from "./context/TaskContextBuilder.js";
export {
  runRoute,
  type RunRouteInput,
  type RunRouteResult,
  type RunRouteOk,
  type RunRouteFail,
  type RunRouteContext,
  type RunRouteDone,
} from "./usecases/runRoute.js";

// MockModelClient — used by tests + downstream consumers wiring a fake provider.
export { MockModelClient, type MockModelClientOptions } from "./model/providers/mock.js";

// v1.2 — workflow sessions
export {
  ExecutionSessionSchema,
  SESSION_STATES,
  type ExecutionSession,
  type SessionEvent,
  type SessionState,
} from "./runtime/session/ExecutionSession.js";
export {
  resolveEffectiveFreedom,
  checkSessionGate,
  type GateInput,
  type GateResult,
} from "./runtime/session/sessionPolicy.js";
export {
  startSession,
  getCurrentSession,
  advanceSession,
  approvePlan,
  abandonSession,
  getEffectiveFreedom,
  readSession,
  SessionError,
  type StartSessionInput,
  type StartSessionResult,
  type GetCurrentSessionInput,
  type GetCurrentSessionResult,
  type AdvanceSessionInput,
  type ApprovePlanInput,
  type AbandonSessionInput,
} from "./usecases/session.js";

// Runtime config schema (added in v1.0)
export { RuntimeConfigSchema } from "./config/TierkitConfig.js";

// v1.6: GUI HTML asset (used by direct browser serve + by host extensions embedding a webview)
export { GUI_HTML } from "./runtime/ui/gui.js";

// Model provider clients
export {
  pickProviderClient,
  OllamaClient,
  OpenAICompatibleClient,
  AnthropicClient,
  ProviderError,
  type ProviderClient,
  type ProbeResult,
  type ProbeOk,
  type ProbeFail,
} from "./model/providers/index.js";

export { runChild, mergeEnv, quoteForWindowsShell, type RunChildOptions } from "./model/providers/runChild.js";

export {
  doctor,
  type DoctorInput,
  type DoctorResult,
  type DoctorCheck,
  type CheckStatus,
} from "./usecases/doctor.js";

// Context compression (v1.7-spike)
export {
  type ContextBudget,
  type ContextArtifact,
  type RelevantFile,
  type FileExcerpt,
  type SymbolEntry,
  type Hotspot,
  type CompareResult,
  type CompareSide,
  type SourceLanguage,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_IGNORE_GLOBS,
} from "./context-compression/types.js";

export {
  ContextArtifactSchema,
  ContextCompressionConfigSchema,
  ContextBudgetSchema,
  RelevantFileSchema,
  FileExcerptSchema,
  CompareResultSchema,
  CompareSideSchema,
} from "./context-compression/schema.js";

export {
  buildCompressedContext,
  type BuildCompressedContextInput,
  type BuildCompressedContextResult,
} from "./usecases/buildCompressedContext.js";

export {
  writeArtifact,
  readArtifact,
  mutateArtifact,
  artifactRelativePath,
  ContextArtifactStoreError,
  type ContextArtifactStoreErrorCode,
  type WriteArtifactOptions,
  type WriteArtifactResult,
  type ReadArtifactResult,
} from "./runtime/contextArtifactStore.js";

export {
  QUALITY_VERDICTS,
  type QualityVerdict,
  VerdictSchema,
  type ArtifactVerdict,
  readVerdict,
  writeVerdict,
  VerdictStoreError,
  type VerdictStoreErrorCode,
} from "./runtime/verdictStore.js";

export {
  sendCompressedContext,
  type SendCompressedContextInput,
  type SendCompressedContextResult,
  type RouteRunner,
} from "./usecases/sendCompressedContext.js";

export {
  compareCompressedContext,
  type CompareCompressedContextInput,
  type CompareCompressedContextResult,
} from "./usecases/compareCompressedContext.js";

// v0.12.1: re-export the single-source-of-truth version constant so the CLI
// banner (Cli#binaryVersion) stays in sync with packages/core/package.json
// without a separate hardcoded literal in packages/cli/src/cli.ts.
export { TIERKIT_VERSION } from "./version.js";

// v0.15 MCP Bridge — activity log (shared by mcp-server, CLI, and daemon)
export {
  logMcpActivity,
  readMcpActivity,
  type McpActivityInput,
  type McpActivityEntry,
} from "./mcp/activityLog.js";

// v0.18 Context Gateway — local digest pipeline (command, error, test, json, diff, file, pack)
export {
  type CompressionVerdict,
  type CompressionStats,
  type CompressedCommand,
  type DigestErrorItem,
  type ErrorDigest,
  type TestFailureItem,
  type TestDigest,
  type JsonDigest,
  type FileDigest,
  type DiffSummary,
  type CleanedContext,
  type ContextPack,
  type DigestBudget,
  DEFAULT_DIGEST_BUDGET,
  CONTEXT_PACK_OUTPUT_POLICY,
  computeStats as computeDigestStats,
  makeDigestId,
  compressCommand,
  type CompressCommandOptions,
  compressErrorLog,
  type CompressErrorLogOptions,
  compressTestOutput,
  type CompressTestOutputOptions,
  compressJson,
  type CompressJsonOptions,
  cleanContext,
  type CleanContextOptions,
  summarizeGitDiff,
  defaultDiffRunner,
  type SummarizeGitDiffOptions,
  getFileDigest,
  getFileDigestCached,
  invalidateFileDigest,
  getFileDigestCacheStats,
  clearFileDigestCache,
  type GetFileDigestOptions,
  type FileDigestCacheStats,
  buildContextPack,
  type BuildContextPackInput,
  type BuildContextPackOptions,
  makeRefineCallback,
  type MakeRefineCallbackOptions,
} from "./digest/index.js";

// v0.20: Claude Code auto-wire (MCP config + CLAUDE.md instructions)
export {
  connectClaudeCode,
  disconnectClaudeCode,
  claudeCodeStatus,
  type ConnectClaudeCodeInput,
  type ConnectClaudeCodeResult,
  type DisconnectClaudeCodeInput,
  type DisconnectClaudeCodeResult,
  type ClaudeCodeStatusInput,
  type ClaudeCodeStatusResult,
  type ConnectScope,
  type InstructionsLevel,
} from "./usecases/connectClaudeCode.js";

// v0.21: Tierkit Chat as a streaming proxy over the claude CLI
export {
  chatWithClaude,
  type ChatEvent,
  type ChatWithClaudeOptions,
  type ClaudePermissionMode,
} from "./usecases/chatWithClaude.js";

// v0.15 MCP Bridge — patch ticket store (shared by mcp-server, CLI, and daemon)
export {
  // CRUD
  createPatchTicket,
  readPatchTicket,
  listPatchTickets,
  updatePatchTicket,
  deletePatchTicket,
  // state-guarded transitions
  approvePatchTicket,
  rejectPatchTicket,
  // payload sidecar
  writePatchPayload,
  readPatchPayload,
  // GC
  cleanupExpiredAndApplied,
  // error
  InvalidPatchStateError,
  // types
  type PatchTicket,
  type PatchFileEntry,
  type PatchApproval,
  type PatchStatus,
  type ApprovalState,
  type CreatePatchInput,
  type ApprovedBy,
} from "./mcp/patchStore.js";
