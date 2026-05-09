/**
 * Test d'intégration manuel pour la v0.2 (auth + écriture).
 * / Manual integration test for v0.2 (auth + write).
 *
 * LOCALISATION : tests/integration-auth.test.ts
 *
 * Lance avec : npm run test:integration:auth
 * Prérequis : DOCS_INSTANCE_URL, DOCS_INTEGRATION_SESSIONID, DOCS_INTEGRATION_CSRFTOKEN
 *
 * Scénario :
 *   1. Set credentials
 *   2. Create un doc top-level
 *   3. Create un sous-doc
 *   4. Rename le sous-doc
 *   5. List my documents → vérifier les 2 docs présents
 *   6. Move le sous-doc en racine
 *   7. Duplicate le doc top-level
 *   8. Cleanup : delete les 3 docs créés
 *
 * Idempotent : nettoie en cas d'échec partiel.
 */

import { CredentialsStore } from '../src/auth/credentials.js';
import { InstanceStore } from '../src/auth/instance.js';
import { DocsRestClient } from '../src/docs/client.js';

async function main(): Promise<void> {
  const docsInstanceUrl = process.env.DOCS_INSTANCE_URL;
  const sessionid = process.env.DOCS_INTEGRATION_SESSIONID;
  const csrftoken = process.env.DOCS_INTEGRATION_CSRFTOKEN;

  if (!docsInstanceUrl || !sessionid || !csrftoken) {
    console.error('Missing env: DOCS_INSTANCE_URL, DOCS_INTEGRATION_SESSIONID, DOCS_INTEGRATION_CSRFTOKEN');
    process.exit(1);
  }

  const instanceStore = InstanceStore.fromEnv({ DOCS_INSTANCE_URL: docsInstanceUrl });
  const credentialsStore = new CredentialsStore();
  credentialsStore.set({ docs_sessionid: sessionid, csrftoken });
  const client = new DocsRestClient(instanceStore, credentialsStore);

  const createdIds: string[] = [];

  try {
    console.log('[1/8] Create top-level...');
    const top = await client.createDocument('MCP v0.2 test — top', null);
    createdIds.push(top.id);
    console.log('      created', top.id);

    console.log('[2/8] Create sub-doc...');
    const sub = await client.createDocument('MCP v0.2 test — sub', top.id);
    createdIds.push(sub.id);
    console.log('      created', sub.id);

    console.log('[3/8] Update title of sub-doc...');
    await client.updateDocumentTitle(sub.id, 'MCP v0.2 test — sub (renamed)');

    console.log('[4/8] List my documents...');
    const myDocs = await client.listMyDocuments(1, 100);
    const found = myDocs.results.filter((d) => createdIds.includes(d.id));
    if (found.length < 2) {
      throw new Error(`Expected at least 2 docs in list_my_documents, got ${found.length}`);
    }
    console.log('      OK,', found.length, 'docs found');

    console.log('[5/8] Duplicate top-level...');
    const dup = await client.duplicateDocument(top.id, false);
    createdIds.push(dup.id);
    console.log('      duplicated as', dup.id);

    console.log('[6/8] Cleanup duplicate...');
    await client.deleteDocument(dup.id);

    console.log('[7/8] Cleanup top (cascades on sub)...');
    await client.deleteDocument(top.id);

    console.log('');
    console.log('✅ v0.2 integration test PASSED');
  } catch (err) {
    console.error('❌ v0.2 integration test FAILED:', err);
    console.log('Cleanup attempt...');
    for (const id of createdIds) {
      try {
        await client.deleteDocument(id);
        console.log('  cleaned', id);
      } catch (e) {
        console.error('  cleanup failed for', id, e);
      }
    }
    process.exit(1);
  }
}

main();
