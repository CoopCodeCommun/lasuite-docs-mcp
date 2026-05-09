/**
 * Repro pour le bug #3 remonté par Jonas :
 * insert_block accepte le text mais read_document retourne text: ""
 *
 * Ce script simule un process MCP long-vivant (comme Claude Desktop) :
 * insert + read dans la même session, sans process éphémère.
 */

import { CredentialsStore } from '../src/auth/credentials.js';
import { InstanceStore } from '../src/auth/instance.js';
import { SessionManager } from '../src/docs/session.js';
import { DocsRestClient } from '../src/docs/client.js';

const DOC_ID = 'ccf11f43-a52e-48c6-bcb2-1858f8a42256';
const INSTANCE_URL = 'https://notes.liiib.re';

async function main() {
  const instanceStore = InstanceStore.fromEnv({ DOCS_INSTANCE_URL: INSTANCE_URL });
  const credentialsStore = new CredentialsStore();
  const sessionManager = new SessionManager(INSTANCE_URL, 300_000, 10_000, credentialsStore);
  const client = new DocsRestClient(instanceStore, credentialsStore);

  console.log('[1] Insert markdown bloc');
  const blockId = await sessionManager.insertBlock(
    DOC_ID,
    { type: 'paragraph', text: 'Repro : **gras** et [lien](https://example.com).' },
    null,
  );
  console.log('    block_id:', blockId);

  console.log('[2] Read immédiatement (même process, même session)');
  const blocks = await sessionManager.readDocument(DOC_ID);
  for (const b of blocks) {
    console.log(`    id=${b.id.slice(0, 8)} type=${b.type} text=${JSON.stringify(b.text)}`);
  }

  console.log('[3] Cleanup');
  await sessionManager.deleteBlock(DOC_ID, blockId);

  sessionManager.shutdown();
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
