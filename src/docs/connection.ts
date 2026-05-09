/**
 * Wrapper sur le client WebSocket `ws` qui injecte les en-têtes attendus
 * par le serveur Hocuspocus de la-suite Docs.
 * / Wrapper around the `ws` client that injects headers required by the
 * Hocuspocus server of la-suite Docs.
 *
 * LOCALISATION : src/docs/connection.ts
 *
 * v0.2 : si CredentialsStore.has() au moment de la connexion, on envoie
 * les vrais cookies de l'utilisateur (docs_sessionid + csrftoken). Sinon,
 * cookie bidon comme en v0.1 (suffisant pour les docs publics).
 *
 * Le serveur de collaboration de Docs (`y-provider`) impose deux contrôles
 * au handshake WebSocket :
 *   1. Header `Origin` doit valoir l'URL de l'instance.
 *   2. Header `Cookie` doit être présent (n'importe quelle valeur suffit
 *      pour les docs publics).
 *
 * COMMUNICATION :
 * Importé par : session.ts (pour fournir le polyfill au HocuspocusProviderWebsocket).
 */

import WebSocketBase from 'ws';
import type { CredentialsStore } from '../auth/credentials.js';

const ANONYMOUS_COOKIE = 'docs_sessionid=anonymous-bot';

/**
 * Construit le header Cookie à envoyer au serveur Hocuspocus.
 * Si des credentials utilisateur sont en mémoire, les utilise.
 * Sinon, utilise un cookie bidon (suffisant pour les docs publics).
 * / Builds the Cookie header. Uses real user credentials if available,
 * / falls back to a dummy cookie otherwise.
 */
function buildCookieHeader(credentialsStore?: CredentialsStore): string {
  if (credentialsStore && credentialsStore.has()) {
    const credentials = credentialsStore.get()!;
    return `docs_sessionid=${credentials.docs_sessionid}; csrftoken=${credentials.csrftoken}`;
  }
  return ANONYMOUS_COOKIE;
}

/**
 * Crée une classe DocsWebSocket configurée pour une instance Docs donnée.
 * / Creates a DocsWebSocket class configured for a given Docs instance.
 *
 * @param docsInstanceUrl - URL HTTPS de l'instance Docs
 * @param credentialsStore - optionnel ; si fourni, ses credentials seront
 *                           utilisés à chaque ouverture de connexion. Si
 *                           absent ou vide, on utilise un cookie bidon.
 */
export function createDocsWebSocketClass(
  docsInstanceUrl: string,
  credentialsStore?: CredentialsStore,
): typeof WebSocketBase {
  const expectedOrigin = new URL(docsInstanceUrl).origin;

  class DocsWebSocket extends WebSocketBase {
    constructor(address: string | URL, protocols?: string | string[] | Record<string, unknown>) {
      // Le cookie est calculé À CHAQUE construction, pour prendre en compte
      // un set/clear récent de credentials sans avoir à recréer la classe.
      // / Cookie computed on each construction to honor recent set/clear.
      super(address, protocols as string | string[] | undefined, {
        origin: expectedOrigin,
        headers: {
          Cookie: buildCookieHeader(credentialsStore),
        },
        ...(typeof protocols === 'object' && !Array.isArray(protocols) ? protocols : {}),
      });
    }
  }

  return DocsWebSocket as unknown as typeof WebSocketBase;
}
