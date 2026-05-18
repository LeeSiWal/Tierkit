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
} from "./model/ModelProfile.js";
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
  CONFIG_FILENAME,
  type TierkitConfig,
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
  appendUsage,
  readUsage,
  summarizeUsage,
  estimateCost,
  type UsageRecord,
  type UsageSummary,
} from "./runtime/usageLog.js";
export { checkBudget, type BudgetCheckResult, type BudgetStatus, type BudgetPolicy } from "./runtime/budget.js";
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

export {
  doctor,
  type DoctorInput,
  type DoctorResult,
  type DoctorCheck,
  type CheckStatus,
} from "./usecases/doctor.js";
