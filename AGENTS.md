# ByteCave Core - Agent Guide

## Overview
ByteCave Core is the foundational P2P storage node implementation. It provides decentralized blob storage with on-chain node registration, replication, and content verification.

## Critical Dependencies

### Internal Dependencies
- **None** - This is the base package that other ByteCave packages depend on
- All other packages (`bytecave-browser`, `bytecave-desktop`, `web`, `dashboard`) depend on this

### External Dependencies
- **libp2p** - P2P networking stack with WebRTC, WebSockets, and relay support
- **ethers v6** - Ethereum interaction for on-chain node registration
- **TypeScript** - Built with TypeScript, outputs to `dist/`

## Build Process

### Standard Build
```bash
cd bytecave-core
yarn build
```
- Compiles TypeScript to JavaScript in `dist/`
- **CRITICAL**: After any changes to bytecave-core, you MUST rebuild before changes take effect

### When to Rebuild
1. **After any code changes** to bytecave-core source files
2. **Before testing** changes in dependent packages
3. **Before restarting nodes** (bytecave-desktop) to load updated code

### Build Output
- `dist/` - Compiled JavaScript and type definitions
- Used by: `bytecave-browser`, `bytecave-desktop`, `web`, `dashboard`

## Dependent Package Rebuild Chain

When you modify bytecave-core, you typically need to rebuild in this order:

1. **bytecave-core** - `yarn build`
2. **bytecave-browser** (if it uses updated core features) - `yarn build` + **git push** (see bytecave-browser/AGENTS.md)
3. **bytecave-desktop** - Restart nodes to load updated core
4. **web/dashboard** - Only if bytecave-browser was updated (yarn upgrade @hashd/bytecave-browser)

## Key Architecture Concepts

### Storage Authorization
- Uses signed messages for storage requests
- Signature format includes: `contentHash`, `appId`, `timestamp`, `nonce`
- Template: `ByteCave Storage Request for Content Hash\nContent Hash: {contentHash}\nApp ID: {appId}\nTimestamp: {timestamp}\nNonce: {nonce}`

### Replication System
- **Replication Factor**: Configurable (default 3), fetched from on-chain contract
- **shouldVerifyOnChain**: Flag determines if blob requires on-chain CID verification during replication
  - `true`: Messages, posts, listings (content registered on-chain)
  - `false`: Media, test content (not registered on-chain)
- **Automatic Replication**: Triggers on new blob storage AND when new peers connect
- **Health Checks**: Periodic checks ensure blobs meet replication factor

### Content Type vs Verification
- **IMPORTANT**: Do NOT hardcode content type checks for verification logic
- Use `shouldVerifyOnChain` flag instead of checking content types like `['messages', 'posts', 'listings']`
- Content types are for application organization, not security decisions

### P2P Protocols
- `/bytecave/store/1.0.0` - Browser-to-node storage (with authorization)
- `/bytecave/replicate/1.0.0` - Node-to-node replication
- `/bytecave/blob/1.0.0` - Blob retrieval
- `/bytecave/health/1.0.0` - Health checks
- `/bytecave/have-cid/1.0.0` - Query if node has specific CID

## Testing Workflow

### Desktop Nodes (bat-alpha, bat-beta, bat-gamma)
Located in `bytecave-desktop/test-data/`:
- **Logs**: `logs/bat-alpha.log`, `logs/bat-beta.log`, `logs/bat-gamma.log`
- **Data**: `.bytecave/bat-alpha/`, `.bytecave/bat-beta/`, `.bytecave/bat-gamma/`

### After Code Changes
1. Rebuild bytecave-core: `yarn build`
2. Restart desktop nodes (kill Electron apps)
3. Check logs for errors
4. Test storage and replication

## Common Issues

### Stale Node Modules
If dependent packages show old behavior after bytecave-core changes:
1. Ensure bytecave-core was rebuilt
2. For bytecave-browser: Must commit and push to git, then `yarn upgrade @hashd/bytecave-browser` in dependent packages
3. For bytecave-desktop: Restart nodes (they load bytecave-core directly)

### Signature Verification Failures
- Check signature message format matches between client and node
- Verify `appId` is included in signature message
- Ensure timestamp and nonce are passed correctly

### Replication Not Working
- Check replication factor setting
- Verify nodes are registered on-chain
- Check `shouldVerifyOnChain` flag is set correctly
- Review logs for "Replication rejected" messages

## Important Files

### Core Services
- `src/services/storage.service.ts` - Blob storage and metadata management
- `src/services/replication.service.ts` - Replication logic and health checks
- `src/services/p2p-protocols.service.ts` - P2P protocol handlers
- `src/services/storage-authorization.service.ts` - Signature verification

### Type Definitions
- `src/types/index.ts` - Core type definitions including `BlobMetadata`, `StorageAuthorization`

### Configuration
- Uses `config.ts` for runtime configuration
- Nodes store config in `{dataDir}/config.json`

## Package Manager
- **Yarn** - Always use `yarn` not `npm`
- Lock file: `yarn.lock`

## User Preferences
- User prefers separate components over monolithic files
- Avoid temporary fixes - implement full solutions
- Fix lint errors at each step
- Use Yarn as package manager
- Check with user before large code changes
