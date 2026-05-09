/**
 * Wrapper REST sur l'API Django de la-suite Docs.
 * / REST wrapper over the la-suite Docs Django API.
 *
 * LOCALISATION : src/docs/client.ts
 *
 * v0.2 : ajout des méthodes d'écriture (create, delete, move, duplicate,
 * patch title, list mine). Toutes exigent un CredentialsStore non-vide
 * et un InstanceStore settled. Les ops de lecture publique restent
 * anonymes (comportement v0.1 préservé).
 *
 * COMMUNICATION :
 * Importé par : server.ts (pour list, métadonnées, et toutes les ops d'écriture).
 */

import { DocsError } from '../types.js';
import type { CredentialsStore } from '../auth/credentials.js';
import type { InstanceStore } from '../auth/instance.js';
import type { DocumentId, DocumentSummary } from '../types.js';

export type MoveNodePosition = 'first-child' | 'last-child' | 'left' | 'right';

interface CreatedDocumentResult {
  id: DocumentId;
  title: string;
  depth: number;
  path: string;
  link_reach: 'public' | 'authenticated' | 'restricted';
  link_role: 'reader' | 'commenter' | 'editor';
}

interface ListMyDocumentsResult {
  count: number;
  results: DocumentSummary[];
}

export class DocsRestClient {
  constructor(
    private readonly instanceStore: InstanceStore,
    private readonly credentialsStore: CredentialsStore,
  ) {}

  // -----------------------------------------------------------------
  // Lecture (anonyme — comportement v0.1 préservé)
  // / Read methods (anonymous — v0.1 behavior preserved)
  // -----------------------------------------------------------------

  async fetchDocumentMetadata(
    documentIdentifier: DocumentId,
  ): Promise<DocumentSummary & { created_at: string }> {
    const baseUrl = this.requireInstanceOrThrow();
    const apiResponse = await fetch(
      `${baseUrl}/api/v1.0/documents/${documentIdentifier}/`,
    );

    if (apiResponse.status === 404) {
      throw new DocsError(
        'DOC_NOT_FOUND',
        `Document ${documentIdentifier} not found on instance`,
      );
    }
    if (!apiResponse.ok) {
      throw new Error(
        `Unexpected response ${apiResponse.status} when fetching ${documentIdentifier}`,
      );
    }

    const documentData = (await apiResponse.json()) as {
      id: string;
      title: string;
      updated_at: string;
      created_at: string;
      link_reach: 'public' | 'authenticated' | 'restricted';
      link_role: 'reader' | 'commenter' | 'editor';
    };

    if (documentData.link_reach !== 'public' && !this.credentialsStore.has()) {
      throw new DocsError(
        'DOC_NOT_PUBLIC',
        `Document ${documentIdentifier} is not public (link_reach=${documentData.link_reach})`,
      );
    }

    return documentData;
  }

  async assertPublicEditor(documentIdentifier: DocumentId): Promise<void> {
    const documentMetadata = await this.fetchDocumentMetadata(documentIdentifier);
    if (documentMetadata.link_reach !== 'public') {
      throw new DocsError(
        'DOC_NOT_PUBLIC',
        `Document ${documentIdentifier} is not public (link_reach=${documentMetadata.link_reach})`,
      );
    }
    if (documentMetadata.link_role !== 'editor') {
      throw new DocsError(
        'DOC_READONLY',
        `Document ${documentIdentifier} is public but read-only (link_role=${documentMetadata.link_role})`,
      );
    }
  }

  async listPublicDocuments(): Promise<DocumentSummary[]> {
    const baseUrl = this.requireInstanceOrThrow();
    const apiResponse = await fetch(`${baseUrl}/api/v1.0/documents/?page_size=100`);
    if (!apiResponse.ok) {
      throw new Error(
        `Unexpected response ${apiResponse.status} when listing documents`,
      );
    }
    const responseBody = (await apiResponse.json()) as {
      results: DocumentSummary[];
    };
    const publicDocumentList: DocumentSummary[] = [];
    for (const documentRecord of responseBody.results) {
      if (documentRecord.link_reach === 'public') {
        publicDocumentList.push({
          id: documentRecord.id,
          title: documentRecord.title,
          updated_at: documentRecord.updated_at,
          link_reach: documentRecord.link_reach,
          link_role: documentRecord.link_role,
        });
      }
    }
    return publicDocumentList;
  }

  // -----------------------------------------------------------------
  // Écriture (authentifié — exige CredentialsStore non-vide)
  // / Write methods (authenticated — require non-empty CredentialsStore)
  // -----------------------------------------------------------------

  async createDocument(
    title: string,
    parentDocumentId: DocumentId | null,
  ): Promise<CreatedDocumentResult> {
    const url = parentDocumentId
      ? this.buildAuthUrl(`/api/v1.0/documents/${parentDocumentId}/children/`)
      : this.buildAuthUrl(`/api/v1.0/documents/`);
    return this.postJson<CreatedDocumentResult>(url, { title });
  }

  async deleteDocument(documentIdentifier: DocumentId): Promise<void> {
    const url = this.buildAuthUrl(`/api/v1.0/documents/${documentIdentifier}/`);
    await this.requestWithAuth(url, 'DELETE');
  }

  async moveDocument(
    documentIdentifier: DocumentId,
    targetParentDocumentId: DocumentId,
    position: MoveNodePosition,
  ): Promise<void> {
    const url = this.buildAuthUrl(`/api/v1.0/documents/${documentIdentifier}/move/`);
    await this.postJson<unknown>(url, {
      target_document_id: targetParentDocumentId,
      position,
    });
  }

  async duplicateDocument(
    documentIdentifier: DocumentId,
    withAccesses: boolean,
  ): Promise<{ id: DocumentId; title: string }> {
    const url = this.buildAuthUrl(`/api/v1.0/documents/${documentIdentifier}/duplicate/`);
    return this.postJson<{ id: DocumentId; title: string }>(url, {
      with_accesses: withAccesses,
    });
  }

  async updateDocumentTitle(
    documentIdentifier: DocumentId,
    newTitle: string,
  ): Promise<void> {
    const url = this.buildAuthUrl(`/api/v1.0/documents/${documentIdentifier}/`);
    await this.requestWithAuth(url, 'PATCH', { title: newTitle });
  }

  async listMyDocuments(
    page: number,
    pageSize: number,
  ): Promise<ListMyDocumentsResult> {
    const url = this.buildAuthUrl(
      `/api/v1.0/documents/?page=${page}&page_size=${pageSize}`,
    );
    const response = await this.requestWithAuth(url, 'GET');
    return (await response.json()) as ListMyDocumentsResult;
  }

  // -----------------------------------------------------------------
  // Lecture d'arborescence (anonyme ou authentifiée selon visibilité)
  // / Tree reading (anonymous or authenticated depending on doc visibility)
  // -----------------------------------------------------------------

  /**
   * Liste les enfants directs d'un document.
   * Marche en anonyme si le parent et les enfants sont publics.
   * Si CredentialsStore.has(), envoie le cookie pour voir aussi les enfants
   * privés accessibles à l'utilisateur connecté.
   * / Lists direct children of a document. Works anonymously for public docs,
   * / authenticated if credentials present.
   */
  async listDocumentChildren(
    parentDocumentId: DocumentId,
  ): Promise<DocumentSummary[]> {
    const baseUrl = this.requireInstanceOrThrow();
    const url = `${baseUrl}/api/v1.0/documents/${parentDocumentId}/children/?page_size=100`;
    const response = await this.requestPossiblyAuth(url);
    if (response.status === 404) {
      throw new DocsError(
        'DOC_NOT_FOUND',
        `Parent document ${parentDocumentId} not found`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Unexpected response ${response.status} when listing children of ${parentDocumentId}`,
      );
    }
    const body = (await response.json()) as { results: DocumentSummary[] };
    return body.results;
  }

  /**
   * Liste tous les descendants d'un document (récursif côté MCP via children).
   * Si parentDocumentId est null, retourne tous les docs accessibles à
   * l'utilisateur connecté à plat (équivalent /documents/all/).
   * maxDepth borne la récursion pour éviter les surprises sur des arbres profonds.
   * / Lists all descendants of a document (recursive via children) or all
   * / accessible docs if parent is null. maxDepth caps recursion depth.
   */
  async listDocumentDescendants(
    parentDocumentId: DocumentId | null,
    maxDepth: number,
  ): Promise<DocumentSummary[]> {
    if (parentDocumentId === null) {
      return this.listAllAccessibleDocuments();
    }

    // Récursion côté client : pile (DFS) avec borne de profondeur.
    // Chaque niveau = 1 appel HTTP /children/. OK pour des arbres modestes ;
    // pour 100+ docs, l'agent paie en latence — assumé.
    // / Client-side recursion via DFS stack with depth cap.
    const collected: DocumentSummary[] = [];
    const explorationStack: Array<{ id: DocumentId; depthFromRoot: number }> = [
      { id: parentDocumentId, depthFromRoot: 0 },
    ];

    while (explorationStack.length > 0) {
      const current = explorationStack.pop()!;
      if (current.depthFromRoot >= maxDepth) {
        continue;
      }
      const directChildren = await this.listDocumentChildren(current.id);
      for (const child of directChildren) {
        collected.push(child);
        explorationStack.push({
          id: child.id,
          depthFromRoot: current.depthFromRoot + 1,
        });
      }
    }
    return collected;
  }

  /**
   * Liste tous les docs accessibles à l'utilisateur connecté + leurs descendants.
   * Utilise GET /documents/all/ qui inclut déjà les descendants à plat.
   * Sans credentials, ne retourne que les docs publics du user (peu utile).
   * / Uses GET /documents/all/ which already returns descendants flat.
   */
  private async listAllAccessibleDocuments(): Promise<DocumentSummary[]> {
    const baseUrl = this.requireInstanceOrThrow();
    const url = `${baseUrl}/api/v1.0/documents/all/?page_size=100`;
    const response = await this.requestPossiblyAuth(url);
    if (!response.ok) {
      throw new Error(
        `Unexpected response ${response.status} when listing all accessible documents`,
      );
    }
    const body = (await response.json()) as { results: DocumentSummary[] };
    return body.results;
  }

  /**
   * GET avec credentials si disponibles, sinon anonyme.
   * Différent de requestWithAuth (qui exige les credentials).
   * / GET with credentials if available, anonymous otherwise.
   */
  private async requestPossiblyAuth(targetUrl: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.credentialsStore.has() && this.instanceStore.matches(targetUrl)) {
      const credentials = this.credentialsStore.get()!;
      headers.Cookie = `docs_sessionid=${credentials.docs_sessionid}; csrftoken=${credentials.csrftoken}`;
    }
    return fetch(targetUrl, { method: 'GET', headers });
  }

  // -----------------------------------------------------------------
  // Helpers privés
  // / Private helpers
  // -----------------------------------------------------------------

  private requireInstanceOrThrow(): string {
    const origin = this.instanceStore.get();
    if (origin === null) {
      throw new DocsError(
        'INSTANCE_NOT_SET',
        "Aucune instance Docs n'est configurée. Passe-moi un lien complet vers un document (ex: https://notes.liiib.re/docs/<UUID>/) ou définis DOCS_INSTANCE_URL dans la configuration.",
      );
    }
    return origin;
  }

  private buildAuthUrl(pathSegment: string): string {
    const baseUrl = this.requireInstanceOrThrow();
    return `${baseUrl}${pathSegment}`;
  }

  /**
   * Construit les en-têtes pour une requête authentifiée.
   * Vérifie que CredentialsStore.has() et que l'URL match l'instance settled.
   * / Builds headers for an authenticated request.
   */
  private buildAuthHeaders(targetUrl: string): Record<string, string> {
    if (!this.credentialsStore.has()) {
      throw new DocsError(
        'AUTH_REQUIRED',
        this.buildAuthRequiredMessage(),
      );
    }
    if (!this.instanceStore.matches(targetUrl)) {
      throw new DocsError(
        'INSTANCE_MISMATCH',
        `L'URL cible ${targetUrl} ne correspond pas à l'instance active ${this.instanceStore.get()}. Pour switcher d'instance, appelle clear_session_credentials puis fournis-moi un lien vers la nouvelle instance.`,
      );
    }
    const credentials = this.credentialsStore.get()!;
    const instanceOrigin = this.instanceStore.get()!;
    return {
      'Content-Type': 'application/json',
      Cookie: `docs_sessionid=${credentials.docs_sessionid}; csrftoken=${credentials.csrftoken}`,
      Referer: `${instanceOrigin}/`,
      'X-CSRFToken': credentials.csrftoken,
    };
  }

  private async requestWithAuth(
    url: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
  ): Promise<Response> {
    const headers = this.buildAuthHeaders(url);
    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401 || response.status === 403) {
      throw new DocsError(
        'AUTH_REQUIRED',
        this.buildAuthRequiredMessage('expired_or_invalid'),
      );
    }
    if (!response.ok) {
      throw new Error(
        `Unexpected response ${response.status} from ${method} ${url}`,
      );
    }
    return response;
  }

  private async postJson<T>(url: string, body: unknown): Promise<T> {
    const response = await this.requestWithAuth(url, 'POST', body);
    if (response.status === 204) {
      return undefined as unknown as T;
    }
    return (await response.json()) as T;
  }

  private buildAuthRequiredMessage(variant: 'missing' | 'expired_or_invalid' = 'missing'): string {
    const lead = variant === 'expired_or_invalid'
      ? 'Les credentials de session ont expiré ou sont invalides. Recolle-moi des nouvelles valeurs.'
      : 'Cette opération nécessite un cookie de session valide.';
    return `${lead}

Pour récupérer tes 2 cookies sur l'instance Docs cible :

== Chrome / Edge / Brave (Chromium) ==
1. Connecte-toi à l'instance Docs dans ton navigateur (par exemple https://notes.liiib.re).
2. Ouvre les DevTools : F12, ou Ctrl+Shift+I (Windows/Linux), ou Cmd+Option+I (macOS).
3. Onglet "Application" → menu de gauche → "Cookies" → URL de ton instance.
4. Repère les 2 lignes : "docs_sessionid" et "csrftoken". Pour chacune, clic droit sur la cellule "Value" → "Copy value".

== Firefox ==
1. Connecte-toi à l'instance Docs dans ton navigateur.
2. Ouvre les DevTools : F12, ou Ctrl+Shift+I (Windows/Linux), ou Cmd+Option+I (macOS).
3. Onglet "Stockage" (ou "Storage" en anglais).
4. Menu de gauche → "Cookies" → URL de ton instance.
5. Repère les 2 lignes "docs_sessionid" et "csrftoken", clic droit dessus → "Copier la valeur".

Note : "docs_sessionid" est marqué HttpOnly, invisible depuis la console JavaScript — il faut passer par les DevTools.

Le couple expire ~12h après login. Une fois les 2 valeurs copiées, donne-les moi via set_session_credentials. Elles ne sont ni écrites sur disque ni renvoyées dans les réponses de tools.`;
  }
}
