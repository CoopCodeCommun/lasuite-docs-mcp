/**
 * Stocke en mémoire les credentials de session de l'utilisateur connecté
 * sur l'instance Docs (cookie session Django + cookie CSRF).
 *
 * Les credentials sont volontairement non-persistées : pas de fichier sur
 * disque, pas de logs, pas d'inclusion dans les outputs des tools MCP.
 * Les overrides toString / inspect / toJSON empêchent un console.log
 * accidentel de fuiter les valeurs.
 *
 * / In-memory store for the user's Docs session credentials (Django session
 * / cookie + CSRF cookie). Never persisted to disk, never logged.
 *
 * LOCALISATION : src/auth/credentials.ts
 *
 * COMMUNICATION :
 * Importé par : server.ts (instanciation), connection.ts et client.ts
 *               (consommation au moment de construire les requêtes Docs).
 *               Aucun autre module ne doit recevoir ce store.
 */

const INSPECT_SYMBOL = Symbol.for('nodejs.util.inspect.custom');

export interface SessionCredentials {
  docs_sessionid: string;
  csrftoken: string;
}

export class CredentialsStore {
  // Variable privée : aucune référence directe ne sort de la classe.
  // / Private field: no direct reference leaks out of the class.
  #current: SessionCredentials | null = null;

  /**
   * Enregistre un nouveau couple de credentials. Écrase un précédent set.
   * / Stores a new credentials pair. Overwrites any previous set.
   */
  set(credentials: SessionCredentials): void {
    this.#current = {
      docs_sessionid: credentials.docs_sessionid,
      csrftoken: credentials.csrftoken,
    };
  }

  /**
   * Retourne une copie défensive des credentials, ou null si vide.
   * / Returns a defensive copy of credentials, or null if empty.
   */
  get(): SessionCredentials | null {
    if (this.#current === null) {
      return null;
    }
    return {
      docs_sessionid: this.#current.docs_sessionid,
      csrftoken: this.#current.csrftoken,
    };
  }

  /**
   * Vide le store. À appeler explicitement pour "déconnecter".
   * / Empties the store. Call explicitly to "log out".
   */
  clear(): void {
    this.#current = null;
  }

  /**
   * Indique si le store contient des credentials.
   * / Tells whether the store currently holds credentials.
   */
  has(): boolean {
    return this.#current !== null;
  }

  /**
   * Override toString pour empêcher la fuite via concaténation ou console.log.
   * / toString override to prevent leaks via string concatenation or console.log.
   */
  toString(): string {
    return this.has() ? '[CredentialsStore: set]' : '[CredentialsStore: empty]';
  }

  /**
   * Override util.inspect pour empêcher la fuite via console.log d'objet.
   * / util.inspect override to prevent leaks via object logging.
   */
  [INSPECT_SYMBOL](): string {
    return this.toString();
  }

  /**
   * Override toJSON pour empêcher la fuite via JSON.stringify.
   * / toJSON override to prevent leaks via JSON.stringify.
   */
  toJSON(): string {
    return this.toString();
  }
}
