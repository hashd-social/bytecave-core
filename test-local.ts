/**
 * Quick local test script for HASHD Vault + Contracts
 * 
 * Prerequisites:
 * 1. Start hardhat node: cd hardhat && yarn hardhat node
 * 2. Deploy contracts: cd hardhat && yarn hardhat run scripts/deploy-vault-registry.ts --network localhost
 * 3. Set VAULT_REGISTRY_ADDRESS in .env
 * 4. Run: npx tsx test-local.ts
 */

import { contractIntegrationService } from './src/services/contract-integration.service.js';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  red: '\x1b[31m'
};

function log(emoji: string, message: string, data?: any) {
  console.log(`${emoji} ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function testLocalSetup() {
  console.log('\n' + '='.repeat(60));
  console.log('🧪 HASHD VAULT - LOCAL TEST SUITE');
  console.log('='.repeat(60) + '\n');

  try {
    // ============================================
    // 1. CHECK CONFIGURATION
    // ============================================
    log('📋', 'Checking configuration...');
    
    const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
    const privateKey = process.env.PRIVATE_KEY;
    const registryAddress = process.env.VAULT_REGISTRY_ADDRESS;

    if (!privateKey) {
      throw new Error('PRIVATE_KEY not set in .env');
    }
    if (!registryAddress) {
      throw new Error('VAULT_REGISTRY_ADDRESS not set in .env');
    }

    log('✅', 'Configuration OK', {
      rpcUrl,
      registryAddress,
      hasPrivateKey: true
    });

    // ============================================
    // 2. INITIALIZE CONTRACT INTEGRATION
    // ============================================
    log('\n🔌', 'Initializing contract integration...');
    
    await contractIntegrationService.initialize({
      rpcUrl,
      privateKey,
      registryAddress,
      incentivesAddress: process.env.VAULT_INCENTIVES_ADDRESS
    });

    const signerAddress = await contractIntegrationService.getSignerAddress();
    const blockNumber = await contractIntegrationService.getBlockNumber();

    log('✅', 'Contract integration initialized', {
      signerAddress,
      currentBlock: blockNumber
    });

    // ============================================
    // 3. CHECK REGISTRY STATUS
    // ============================================
    log('\n📊', 'Checking registry status...');
    
    const nodeCount = await contractIntegrationService.getNodeCount();
    log('✅', 'Registry status', nodeCount);

    // ============================================
    // 4. REGISTER TEST NODE
    // ============================================
    log('\n🆕', 'Registering test node...');
    
    // Generate random node key
    const nodeKey = ethers.randomBytes(32);
    const publicKey = ethers.hexlify(nodeKey);
    
    // Create metadata
    const metadata = {
      name: 'Local Test Node',
      version: '1.0.0',
      timestamp: Date.now(),
      capabilities: ['storage', 'replication', 'consensus']
    };
    const metadataHash = ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify(metadata))
    );

    const nodeUrl = process.env.NODE_URL || 'http://localhost:3000';

    try {
      const nodeId = await contractIntegrationService.registerNode(
        publicKey,
        nodeUrl,
        metadataHash
      );

      log('✅', 'Node registered successfully!', {
        nodeId,
        publicKey,
        url: nodeUrl,
        metadataHash
      });

      // ============================================
      // 5. VERIFY NODE REGISTRATION
      // ============================================
      log('\n🔍', 'Verifying node registration...');
      
      const nodeInfo = await contractIntegrationService.getNode(nodeId!);
      log('✅', 'Node info retrieved', nodeInfo);

      const isActive = await contractIntegrationService.isNodeActive(nodeId!);
      log('✅', `Node is ${isActive ? 'ACTIVE' : 'INACTIVE'}`);

      // ============================================
      // 6. GET ALL NODES
      // ============================================
      log('\n📋', 'Getting all registered nodes...');
      
      const allNodes = await contractIntegrationService.getAllNodes(0, 10);
      log('✅', `Found ${allNodes.length} node(s)`, allNodes);

      const activeNodes = await contractIntegrationService.getActiveNodes();
      log('✅', `Found ${activeNodes.length} active node(s)`, activeNodes);

      // ============================================
      // 7. TEST INCENTIVES (if configured)
      // ============================================
      if (process.env.VAULT_INCENTIVES_ADDRESS) {
        log('\n💰', 'Testing incentives...');
        
        const incentivesEnabled = await contractIntegrationService.incentivesEnabled();
        log('ℹ️', `Incentives enabled: ${incentivesEnabled}`);

        if (incentivesEnabled) {
          const reputation = await contractIntegrationService.getReputation(nodeId!);
          log('✅', 'Node reputation', reputation);

          const canSubmit = await contractIntegrationService.canSubmitProof(nodeId!);
          log('✅', `Can submit proofs: ${canSubmit}`);

          const rewards = await contractIntegrationService.getClaimableRewards(nodeId!);
          log('✅', `Claimable rewards: ${rewards.toString()}`);
        }
      }

      // ============================================
      // 8. UPDATE NODE
      // ============================================
      log('\n🔄', 'Testing node update...');
      
      const newUrl = 'http://localhost:3001';
      const newMetadata = {
        ...metadata,
        updated: Date.now()
      };
      const newMetadataHash = ethers.keccak256(
        ethers.toUtf8Bytes(JSON.stringify(newMetadata))
      );

      const updated = await contractIntegrationService.updateNode(newUrl, newMetadataHash);
      log('✅', `Node updated: ${updated}`);

      // Verify update
      const updatedNodeInfo = await contractIntegrationService.getNode(nodeId!);
      log('✅', 'Updated node info', {
        url: updatedNodeInfo?.url,
        metadataHash: updatedNodeInfo?.metadataHash
      });

      // ============================================
      // SUCCESS!
      // ============================================
      console.log('\n' + '='.repeat(60));
      log('🎉', colors.green + 'ALL TESTS PASSED!' + colors.reset);
      console.log('='.repeat(60) + '\n');

      log('📝', 'Next steps:');
      console.log('  1. Start vault node: yarn dev');
      console.log('  2. Test blob storage: curl -X POST http://localhost:3000/api/v1/blobs');
      console.log('  3. Test replication: Start multiple nodes');
      console.log('  4. Test consensus: Query with multiple replicas\n');

    } catch (error: any) {
      if (error.message?.includes('OwnerAlreadyRegistered')) {
        log('⚠️', 'Node already registered for this address');
        log('ℹ️', 'This is OK - testing with existing node...');
        
        // Get existing node
        const existingNodeId = await contractIntegrationService.getNode(
          ethers.keccak256(publicKey)
        );
        log('✅', 'Found existing node', existingNodeId);
      } else {
        throw error;
      }
    }

  } catch (error: any) {
    console.log('\n' + '='.repeat(60));
    log('❌', colors.red + 'TEST FAILED!' + colors.reset);
    console.log('='.repeat(60) + '\n');
    
    console.error('Error:', error.message);
    
    if (error.message?.includes('could not detect network')) {
      log('💡', 'Make sure hardhat node is running:');
      console.log('  cd hardhat && yarn hardhat node\n');
    }
    
    if (error.message?.includes('VAULT_REGISTRY_ADDRESS')) {
      log('💡', 'Deploy contracts first:');
      console.log('  cd hardhat && yarn hardhat run scripts/deploy-vault-registry.ts --network localhost');
      console.log('  Then update vault/.env with the contract address\n');
    }

    process.exit(1);
  }
}

// Run tests
testLocalSetup().catch(console.error);
