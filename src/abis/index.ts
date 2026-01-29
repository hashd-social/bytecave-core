/**
 * Contract ABIs for VaultNodeRegistry and related contracts
 * Shared across bytecave-core and bytecave-desktop
 */

export const NODE_REGISTRY_ABI = [
  'function getNode(bytes32 nodeId) view returns (tuple(address owner, bytes publicKey, string peerId, bytes32 metadataHash, uint256 registeredAt, bool active))',
  'function getActiveNodes() view returns (bytes32[])',
  'function getAllNodes(uint256 offset, uint256 limit) view returns (bytes32[])',
  'function getNodeCount() view returns (uint256 total, uint256 active)',
  'function getNodeByOwner(address owner) view returns (bytes32)',
  'function getNodeStake(bytes32 nodeId) view returns (uint256)',
  'function isNodeActive(bytes32 nodeId) view returns (bool)',
  'function registerNode(bytes publicKey, string peerId, bytes32 metadataHash, uint256 stakeAmount, bytes signature) returns (bytes32)',
  'function updateNode(string peerId, bytes32 metadataHash)',
  'function unregisterNode()',
  'function deregisterNode(bytes32 nodeId)',
  'function minVersion() view returns (string)',
  'function setMinVersion(string version)',
  'function replicationFactor() view returns (uint256)',
  'function setReplicationFactor(uint256 factor)',
  'event NodeRegistered(bytes32 indexed nodeId, address indexed owner)',
  'event NodeUpdated(bytes32 indexed nodeId, string peerId, bytes32 metadataHash)',
  'event NodeDeactivated(bytes32 indexed nodeId)',
  'event MinVersionUpdated(string version)',
  'event ReplicationFactorUpdated(uint256 newFactor)'
];

export const HASHD_TOKEN_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)'
];

export const INCENTIVES_ABI = [
  'function getReputation(bytes32 nodeId) view returns (tuple(uint256 totalProofs, uint256 validProofs, uint256 invalidProofs, uint256 missedProofs, uint256 lastActiveBlock, uint256 reliabilityScore, bool blacklisted))',
  'function canSubmitProof(bytes32 nodeId) view returns (bool)',
  'function getClaimableRewards(bytes32 nodeId) view returns (uint256)',
  'function submitProof(bytes32 nodeId, bytes32 cid, uint256 timestamp, bytes32 challenge, bytes signature)',
  'function claimRewards(bytes32 nodeId)',
  'function incentivesEnabled() view returns (bool)',
  'event ProofSubmitted(bytes32 indexed nodeId, bytes32 indexed cid, bool valid)',
  'event RewardsClaimed(bytes32 indexed nodeId, uint256 amount)'
];

export const CONTENT_REGISTRY_ABI = [
  'function isContentRegistered(bytes32 cid) view returns (bool)',
  'function getContentOwner(bytes32 cid) view returns (address)',
  'function getContentAppId(bytes32 cid) view returns (bytes32)',
  'function getContentRecord(bytes32 cid) view returns (tuple(address owner, bytes32 appId, uint256 timestamp))'
];

export const APP_REGISTRY_ABI = [
  'function isAuthorized(bytes32 appId, address sender) external view returns (bool)',
  'function getApp(bytes32 appId) external view returns (string appName, address owner, bool active, uint256 registeredAt, uint256 burnedAmount)',
  'function computeAppId(string appName) external pure returns (bytes32)',
  'function isAppActive(bytes32 appId) external view returns (bool)'
];

export const MESSAGE_STORAGE_ABI = [
  'function getMessageByCID(string cid) view returns (tuple(bool exists, address sender, uint256 timestamp))'
];

export const POST_STORAGE_ABI = [
  'function getPostByCID(string cid) view returns (tuple(bool exists, address author, uint256 timestamp))'
];
