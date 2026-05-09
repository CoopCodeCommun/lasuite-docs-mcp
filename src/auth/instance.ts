/**
 * Stocke en mémoire l'instance Docs "active" pour la session MCP.
 * / In-memory store for the active Docs instance for the MCP session.
 *
 * LOCALISATION : src/auth/instance.ts
 *
 * Une instance est un origin HTTPS (ex: "https://notes.liiib.re").
 * Le store est settled :
 *   1. Au démarrage si DOCS_INSTANCE_URL est dans l'env (compat v0.1).
 *   2. Au premier appel de tool avec un doc_url qui contient /docs/<uuid>/.
 *   3. Explicitement via set_session_credentials({instance_url}).
 *
 * Le store n'est jamais switché silencieusement : un mismatch lève
 * INSTANCE_MISMATCH côté server.ts.
 *
 * COMMUNICATION :
 * Importé par : server.ts (init + dispatch), connection.ts et client.ts
 *               (vérification d'origine au moment de la requête).
 */

const DOCS_URL_PATTERN = /\/docs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export interface ParsedDocsUrl {
  origin: string;
  docId: string;
}

/**
 * Parse une URL pointant vers un document Docs et en extrait l'origine
 * et l'UUID du document.
 * / Parses a Docs document URL and extracts the origin and the doc UUID.
 *
 * Throws si l'URL n'est pas valide ou ne matche pas le pattern /docs/<uuid>/.
 * / Throws if the URL is invalid or doesn't match /docs/<uuid>/.
 */
export function parseDocsUrl(input: string): ParsedDocsUrl {
  const parsed = new URL(input); // throws TypeError si pas une URL
  const match = DOCS_URL_PATTERN.exec(parsed.pathname);
  if (!match) {
    throw new Error(
      `URL does not match the expected pattern /docs/<uuid>/: ${input}`,
    );
  }
  return {
    origin: parsed.origin,
    docId: match[1].toLowerCase(),
  };
}

export class InstanceStore {
  #origin: string | null = null;

  /**
   * Construit un store initialisé depuis l'environnement.
   * Si DOCS_INSTANCE_URL est défini, settle l'instance dès le démarrage.
   * / Builds a store initialized from environment.
   */
  static fromEnv(env: Record<string, string | undefined>): InstanceStore {
    const store = new InstanceStore();
    const fromEnv = env.DOCS_INSTANCE_URL;
    if (fromEnv && fromEnv.trim().length > 0) {
      store.set(fromEnv);
    }
    return store;
  }

  /**
   * Settle l'instance à partir d'une URL ou d'un origin.
   * Normalise systématiquement vers l'origin (sans path ni trailing slash).
   * / Sets the instance from a URL or origin. Always normalizes to origin.
   */
  set(rawUrlOrOrigin: string): void {
    const parsed = new URL(rawUrlOrOrigin);
    this.#origin = parsed.origin;
  }

  /**
   * Retourne l'origine settled, ou null si vide.
   * / Returns the settled origin, or null if empty.
   */
  get(): string | null {
    return this.#origin;
  }

  has(): boolean {
    return this.#origin !== null;
  }

  clear(): void {
    this.#origin = null;
  }

  /**
   * Vrai si l'URL fournie a la même origine que l'instance settled.
   * Faux si le store est vide.
   * / True if the URL has the same origin as the settled instance.
   */
  matches(targetUrl: string): boolean {
    if (this.#origin === null) {
      return false;
    }
    try {
      return new URL(targetUrl).origin === this.#origin;
    } catch {
      return false;
    }
  }

  toString(): string {
    return this.has() ? `[InstanceStore: ${this.#origin}]` : '[InstanceStore: empty]';
  }
}
