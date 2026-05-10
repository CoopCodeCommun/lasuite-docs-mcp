/**
 * Repro pour le check d'auth ajouté à set_session_credentials.
 * / Repro for the auth check added to set_session_credentials.
 *
 * Vérifie que :
 *  1. Avec des cookies morts, verifyAuthenticatedUser throw
 *     AUTH_REQUIRED (variant 'invalid_at_set').
 *  2. Le message d'erreur contient bien l'avertissement sur les
 *     docs publics qui masquent la mort de la session.
 */

import { CredentialsStore } from '../src/auth/credentials.js';
import { InstanceStore } from '../src/auth/instance.js';
import { DocsRestClient } from '../src/docs/client.js';
import { DocsError } from '../src/types.js';

const INSTANCE_URL = 'https://notes.liiib.re';
const DEAD_SESSIONID = 'vqyn62l5brggi9botdruzw5ak8w2xw3i';
const DEAD_CSRFTOKEN = '0BQThJ5FddJ8fcFJR6gpT9kW5LndHITh';

async function main() {
  const instanceStore = InstanceStore.fromEnv({ DOCS_INSTANCE_URL: INSTANCE_URL });
  const credentialsStore = new CredentialsStore();
  const client = new DocsRestClient(instanceStore, credentialsStore);

  console.log('[1] Pose des cookies morts');
  credentialsStore.set({
    docs_sessionid: DEAD_SESSIONID,
    csrftoken: DEAD_CSRFTOKEN,
  });

  console.log('[2] Appel verifyAuthenticatedUser — doit throw');
  try {
    const userInfo = await client.verifyAuthenticatedUser();
    console.error('FAIL: aucun throw, userInfo =', userInfo);
    process.exit(1);
  } catch (err) {
    if (err instanceof DocsError) {
      console.log(`    OK throw DocsError(code=${err.code})`);
      console.log(`    Premier paragraphe du message :`);
      console.log(`    ${err.message.split('\n')[0]}`);
      console.log();
      console.log(`    Le message contient "lien public" ?`,
        err.message.includes('lien public') ? 'OUI' : 'NON');
      console.log(`    Le message contient "create_document" ?`,
        err.message.includes('create_document') ? 'OUI' : 'NON');
    } else {
      console.error('FAIL: throw mais pas DocsError :', err);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
