/**
 * Wrapper sur le client WebSocket `ws` qui injecte les en-têtes attendus
 * par le serveur Hocuspocus de la-suite Docs.
 * / Wrapper around the `ws` client that injects headers required by the
 * Hocuspocus server of la-suite Docs.
 *
 * LOCALISATION : src/docs/connection.ts
 *
 * Le serveur de collaboration de Docs (`y-provider`) impose deux contrôles
 * au handshake WebSocket (cf. src/middlewares.ts du repo Docs) :
 *   1. Header `Origin` doit valoir l'URL de l'instance.
 *   2. Header `Cookie` doit être présent (n'importe quelle valeur suffit
 *      pour les docs publics).
 *
 * Sans ces deux conditions, le serveur ferme avec :
 *   - 4001 "Origin not allowed", ou
 *   - 4001 "No cookies".
 *
 * En plus, ce wrapper est nécessaire car HocuspocusProviderWebsocket
 * appelle `new WebSocketPolyfill(this.url)` avec un seul argument, sans
 * forwarder d'options. Toute personnalisation des en-têtes doit donc
 * passer par une sous-classe de ws.
 *
 * COMMUNICATION :
 * Importé par : session.ts (pour fournir le polyfill au HocuspocusProviderWebsocket).
 */

import WebSocketBase from 'ws';

/**
 * Crée une classe DocsWebSocket configurée pour une instance Docs donnée.
 * / Creates a DocsWebSocket class configured for a given Docs instance.
 *
 * On retourne une classe (pas une instance) car HocuspocusProviderWebsocket
 * attend une référence de constructeur dans son option `WebSocketPolyfill`.
 * / We return a class (not an instance) because HocuspocusProviderWebsocket
 * expects a constructor reference in its `WebSocketPolyfill` option.
 *
 * @param docsInstanceUrl - URL HTTPS de l'instance Docs (ex: https://notes.liiib.re)
 * @returns Une sous-classe de ws.WebSocket prête à être passée à Hocuspocus
 */
export function createDocsWebSocketClass(
  docsInstanceUrl: string,
): typeof WebSocketBase {
  // Dérive l'origin attendue par le serveur Hocuspocus.
  // / Derive the Origin expected by the Hocuspocus server.
  const expectedOrigin = new URL(docsInstanceUrl).origin;

  // Cookie bidon : suffit pour les docs publics (le serveur exige juste
  // *un* cookie, mais ne valide pas son contenu pour les docs publics).
  // / Dummy cookie: sufficient for public docs.
  const dummyCookie = 'docs_sessionid=anonymous-bot';

  class DocsWebSocket extends WebSocketBase {
    constructor(address: string | URL, protocols?: string | string[] | Record<string, unknown>) {
      // Call parent with expanded options including origin and cookie headers
      super(address, protocols as string | string[] | undefined, {
        origin: expectedOrigin,
        headers: {
          Cookie: dummyCookie,
        },
        // Spread any additional options passed in (if it's options, not protocols)
        ...(typeof protocols === 'object' && !Array.isArray(protocols) ? protocols : {}),
      });
    }
  }

  return DocsWebSocket as unknown as typeof WebSocketBase;
}
