export {
  createOperationCoordinator,
  type BranchTarget,
  type CoordinatedOperation,
  type CoordinatedOperationSummary,
  type OperationAdmission,
  type OperationCoordinator,
  type OperationExecution,
  type ReconciledOperationResult,
} from './operation-coordinator.js';
export {
  createRepositoryEngine,
  type DiscoveredHead,
  type DiscoveredWorktree,
  type GitLockState,
  type RepositoryDiscovery,
  type RepositoryEngine,
  type RepositoryOpenResult,
  type RepositorySession,
  type WorktreeAvailability,
} from './repository-engine.js';
