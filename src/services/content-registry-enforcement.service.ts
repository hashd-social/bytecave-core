/**
 * ByteCave - Content Registry Enforcement Service
 * 
 * Enforces that only registered content can be stored/replicated
 * Implements hybrid approach: check app allowlist first, then verify ContentRegistry
 */

import { logger } from '../utils/logger.js';
import { contractIntegrationService } from './contract-integration.service.js';

export interface ContentVerificationResult {
  authorized: boolean;
  appId?: string;
  error?: string;
}

export class ContentRegistryEnforcementService {
  /**
   * Verify content is registered and authorized for replication
   * 
   * Step 1: Check if appId is in node's allowlist (if configured)
   * Step 2: Verify content is registered in ContentRegistry
   * Step 3: Verify the registered appId matches allowlist
   * 
   * @param cid Content identifier
   * @param requestAppId AppId from replication request (optional)
   * @param allowedApps Node's app allowlist (undefined = accept all registered apps)
   * @returns Verification result with authorization status
   */
  async verifyContentForReplication(
    cid: string,
    requestAppId: string | undefined,
    allowedApps: string[] | undefined
  ): Promise<ContentVerificationResult> {
    // Check if ContentRegistry is configured
    if (!contractIntegrationService.isInitialized()) {
      return {
        authorized: false,
        error: 'ContentRegistry not configured - node cannot verify content'
      };
    }

    try {
      // STEP 1: If node has app allowlist and request provided appId, check it first
      const hasAllowedAppsFilter = allowedApps && allowedApps.length > 0;
      
      if (hasAllowedAppsFilter && requestAppId) {
        if (!allowedApps.includes(requestAppId)) {
          logger.debug('App allowlist check failed', { 
            requestAppId, 
            allowedApps 
          });
          return {
            authorized: false,
            appId: requestAppId,
            error: `App '${requestAppId}' not in node's allowed list`
          };
        }
        logger.debug('App allowlist check passed', { requestAppId });
      }

      // STEP 2: MANDATORY - Verify content is registered in ContentRegistry
      const verification = await contractIntegrationService.verifyContentRegistration(
        cid,
        allowedApps
      );

      if (!verification.authorized) {
        logger.warn('ContentRegistry verification failed', {
          cid: cid.slice(0, 16) + '...',
          error: verification.error,
          registeredAppId: verification.appId
        });
        return verification;
      }

      // STEP 3: All checks passed
      logger.debug('✅ Content authorized for replication', {
        cid: cid.slice(0, 16) + '...',
        appId: verification.appId,
        hasAllowlist: hasAllowedAppsFilter
      });

      return {
        authorized: true,
        appId: verification.appId
      };

    } catch (error: any) {
      logger.error('Content verification error', {
        cid: cid.slice(0, 16) + '...',
        error: error.message
      });
      return {
        authorized: false,
        error: `Verification failed: ${error.message}`
      };
    }
  }

  /**
   * Check if enforcement is enabled (ContentRegistry is configured)
   */
  isEnforcementEnabled(): boolean {
    return contractIntegrationService.isInitialized();
  }
}

export const contentRegistryEnforcementService = new ContentRegistryEnforcementService();
