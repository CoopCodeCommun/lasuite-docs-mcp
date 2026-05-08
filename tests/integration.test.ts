/**
 * Test d'intégration manuel pour lasuite-docs-mcp.
 * / Manual integration test for lasuite-docs-mcp.
 *
 * LOCALISATION : tests/integration.test.ts
 *
 * Lance avec : npm run test:integration
 * Prérequis : variables d'env DOCS_INSTANCE_URL et DOCS_INTEGRATION_DOC_ID
 *
 * Scénario :
 *   1. Read initial du doc (snapshot count)
 *   2. Insert d'un paragraphe au début
 *   3. Read et vérification que le paragraphe est présent
 *   4. Update du paragraphe
 *   5. Read et vérification du nouveau texte
 *   6. Delete du paragraphe
 *   7. Read et vérification que le doc est revenu à son état initial
 *
 * Le test est idempotent : il nettoie son bloc en cas d'échec partiel.
 * / Idempotent: cleans up its block even on partial failure.
 */

import { SessionManager } from '../src/docs/session.js';
import { DocsRestClient } from '../src/docs/client.js';

async function main(): Promise<void> {
  const docsInstanceUrl = process.env.DOCS_INSTANCE_URL;
  const integrationDocumentId = process.env.DOCS_INTEGRATION_DOC_ID;

  if (!docsInstanceUrl || !integrationDocumentId) {
    console.error(
      'Missing DOCS_INSTANCE_URL or DOCS_INTEGRATION_DOC_ID in env.',
    );
    process.exit(1);
  }

  const docsRestClient = new DocsRestClient(docsInstanceUrl);
  const sessionManager = new SessionManager(docsInstanceUrl, 300_000, 10_000);

  let createdBlockId: string | null = null;

  try {
    console.log(`[1/7] Vérification que le doc est public...`);
    await docsRestClient.assertPublicEditor(integrationDocumentId);

    console.log(`[2/7] Read initial...`);
    const initialBlocks = await sessionManager.readDocument(
      integrationDocumentId,
    );
    const initialBlockCount = initialBlocks.length;
    console.log(`      ${initialBlockCount} blocs initiaux`);

    console.log(`[3/7] Insert d'un paragraphe au début...`);
    createdBlockId = await sessionManager.insertBlock(
      integrationDocumentId,
      { type: 'paragraph', text: 'Test integration #1' },
      null,
    );
    console.log(`      block_id créé: ${createdBlockId}`);

    console.log(`[4/7] Read et vérification...`);
    const blocksAfterInsert = await sessionManager.readDocument(
      integrationDocumentId,
    );
    const insertedBlock = blocksAfterInsert.find(
      (block) => block.id === createdBlockId,
    );
    if (!insertedBlock || insertedBlock.text !== 'Test integration #1') {
      throw new Error('Bloc inséré introuvable ou texte incorrect');
    }
    console.log(`      OK, bloc trouvé avec le bon texte`);

    console.log(`[5/7] Update du texte...`);
    await sessionManager.updateBlockText(
      integrationDocumentId,
      createdBlockId,
      'Test integration #2 (modifié)',
    );

    console.log(`[6/7] Read et vérification du nouveau texte...`);
    const blocksAfterUpdate = await sessionManager.readDocument(
      integrationDocumentId,
    );
    const updatedBlock = blocksAfterUpdate.find(
      (block) => block.id === createdBlockId,
    );
    if (!updatedBlock || updatedBlock.text !== 'Test integration #2 (modifié)') {
      throw new Error('Texte non mis à jour');
    }
    console.log(`      OK, nouveau texte vérifié`);

    console.log(`[7/7] Delete et vérification que le bloc est parti...`);
    await sessionManager.deleteBlock(integrationDocumentId, createdBlockId);
    const blocksAfterDelete = await sessionManager.readDocument(
      integrationDocumentId,
    );
    const stillThere = blocksAfterDelete.find(
      (block) => block.id === createdBlockId,
    );
    if (stillThere) {
      throw new Error('Bloc supprimé toujours présent');
    }
    if (blocksAfterDelete.length !== initialBlockCount) {
      throw new Error(
        `Doc count incorrect : ${blocksAfterDelete.length} vs ${initialBlockCount} attendu`,
      );
    }
    console.log(`      OK, doc revenu à son état initial`);

    createdBlockId = null;
    console.log('');
    console.log('✅ Integration test PASSED');
  } catch (caughtError) {
    console.error('❌ Integration test FAILED:', caughtError);
    if (createdBlockId) {
      console.log(`Cleanup : tentative de suppression du bloc ${createdBlockId}...`);
      try {
        await sessionManager.deleteBlock(integrationDocumentId, createdBlockId);
        console.log('Cleanup OK');
      } catch (cleanupError) {
        console.error('Cleanup failed:', cleanupError);
      }
    }
    process.exit(1);
  } finally {
    sessionManager.shutdown();
  }
}

main();
