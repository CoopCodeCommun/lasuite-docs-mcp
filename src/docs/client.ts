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

  /**
   * Récupère les métadonnées d'un document.
   * v0.3.1 : utilise les credentials si présents (sinon GET anonyme).
   * Permet d'accéder aux docs privés authentifiés.
   * / v0.3.1: uses credentials if present (anonymous GET otherwise).
   */
  async fetchDocumentMetadata(
    documentIdentifier: DocumentId,
  ): Promise<DocumentSummary & {
    created_at: string;
    abilities: Record<string, boolean>;
    // Yjs binary state encodé en base64 — utilisé pour l'hydratation
    // initiale du Y.Doc local côté MCP (le serveur Hocuspocus ne pousse
    // pas ce contenu si aucun autre client n'est connecté au moment où
    // le MCP ouvre la WS).
    // / Yjs binary state base64-encoded — used to seed the local Y.Doc
    // / (Hocuspocus does not hydrate from REST snapshot on its own).
    content?: string;
  }> {
    const baseUrl = this.requireInstanceOrThrow();
    const url = `${baseUrl}/api/v1.0/documents/${documentIdentifier}/`;
    const apiResponse = await this.requestPossiblyAuth(url);

    if (apiResponse.status === 404) {
      throw new DocsError(
        'DOC_NOT_FOUND',
        `Document ${documentIdentifier} not found on instance`,
      );
    }
    if (apiResponse.status === 401) {
      // 401 : pas authentifié (ou session expirée). Si on n'a pas de creds,
      // on traite comme un doc privé. Si on a des creds, c'est qu'elles
      // sont mortes côté serveur (expirées, supprimées, mauvais cookie).
      // / 401: not authenticated. No creds → private doc; with creds → expired.
      if (!this.credentialsStore.has()) {
        throw new DocsError(
          'DOC_NOT_PUBLIC',
          `Document ${documentIdentifier} requires authentication (no credentials provided).`,
        );
      }
      throw new DocsError(
        'AUTH_REQUIRED',
        this.buildAuthRequiredMessage('expired_or_invalid'),
      );
    }
    if (apiResponse.status === 403) {
      // 403 : authentifié mais pas autorisé (ou doc privé pour anonyme).
      // Sans creds, on traite comme privé (équivalent 401 fonctionnellement).
      // Avec creds, c'est une vraie permission refusée — pas une session morte.
      // Lever AUTH_REQUIRED ici trompe l'agent qui repose des cookies inutilement.
      // / 403: authenticated but forbidden (or private doc for anonymous).
      // / Avoid AUTH_REQUIRED with creds — it misleads the agent.
      if (!this.credentialsStore.has()) {
        throw new DocsError(
          'DOC_NOT_PUBLIC',
          `Document ${documentIdentifier} requires authentication (no credentials provided).`,
        );
      }
      throw new DocsError(
        'PERMISSION_DENIED',
        await this.buildPermissionDeniedMessage(apiResponse, `GET ${url}`),
      );
    }
    if (!apiResponse.ok) {
      throw new Error(
        `Unexpected response ${apiResponse.status} when fetching ${documentIdentifier}`,
      );
    }

    return (await apiResponse.json()) as DocumentSummary & {
      created_at: string;
      abilities: Record<string, boolean>;
      content?: string;
    };
  }

  /**
   * Vérifie qu'on a accès en édition au doc.
   * v0.3.1 : refactoré pour fonctionner avec docs privés authentifiés.
   * On délègue à `abilities` retournées par l'API plutôt qu'à un check
   * statique sur link_reach/link_role.
   * / v0.3.1: refactored to work with authenticated private docs by
   * / using the API's `abilities` field instead of static link_reach check.
   *
   * Anciennement nommée `assertPublicEditor` (v0.2). Le nouveau nom reflète
   * mieux le scope : "j'ai le droit d'éditer le contenu de ce doc".
   */
  async assertEditAccess(documentIdentifier: DocumentId): Promise<void> {
    const documentMetadata = await this.fetchDocumentMetadata(documentIdentifier);
    const abilities = documentMetadata.abilities ?? {};
    // `partial_update` (PATCH) ou `update` (PUT) signifient qu'on peut
    // modifier le doc. `can_edit` (alias plus récent) aussi.
    // / partial_update / update / can_edit all imply edit access.
    const canEdit = abilities.partial_update === true
      || abilities.update === true
      || abilities.can_edit === true;
    if (!canEdit) {
      throw new DocsError(
        'DOC_READONLY',
        `Document ${documentIdentifier} is read-only for the current session (abilities.partial_update / update / can_edit all false).`,
      );
    }
  }

  /** @deprecated v0.2 alias — utiliser assertEditAccess */
  async assertPublicEditor(documentIdentifier: DocumentId): Promise<void> {
    return this.assertEditAccess(documentIdentifier);
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

  /**
   * Vérifie que les credentials actuellement stockés ouvrent bien une
   * session côté serveur Django, en pingant /api/v1.0/users/me/.
   * / Confirms the current credentials open a real Django session by
   * / pinging /api/v1.0/users/me/.
   *
   * À appeler juste après set_session_credentials. Sans cette vérif, un
   * agent qui pose des cookies morts peut être trompé par le fait que
   * read_document, insert_block, etc. continuent de fonctionner — non pas
   * grâce aux cookies, mais parce que beaucoup de docs Docs sont en
   * computed_link_reach=public/editor, ce qui permet à TOUT LE MONDE
   * (même non authentifié) de lire et d'éditer leur contenu via Yjs.
   * Seules les opérations REST exigeant une vraie identité Django
   * (comme create_document) échouent — ce qui crée l'illusion "4 ops sur
   * 5 marchent avec mes creds, donc mes creds sont valides", alors que
   * toutes ces 4 ops marchaient en réalité sans aucun cookie.
   * / Without this, dead cookies pass undetected because most public docs
   * / accept anonymous reads/writes via the public link, masking the auth.
   *
   * Lève DocsError('AUTH_REQUIRED', variant 'invalid_at_set') si le
   * serveur retourne 401/403. Retourne le body de /users/me/ en cas de
   * succès (l'appelant peut y trouver email, full_name, etc. pour les
   * exposer à l'agent).
   */
  async verifyAuthenticatedUser(): Promise<Record<string, unknown>> {
    const baseUrl = this.requireInstanceOrThrow();
    if (!this.credentialsStore.has()) {
      throw new DocsError(
        'AUTH_REQUIRED',
        this.buildAuthRequiredMessage('missing'),
      );
    }
    const url = `${baseUrl}/api/v1.0/users/me/`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildAuthHeaders(url),
    });
    if (response.status === 401 || response.status === 403) {
      throw new DocsError(
        'AUTH_REQUIRED',
        this.buildAuthRequiredMessage('invalid_at_set'),
      );
    }
    if (!response.ok) {
      throw new Error(
        `Unexpected response ${response.status} from GET ${url}`,
      );
    }
    return (await response.json()) as Record<string, unknown>;
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

  /**
   * Persiste explicitement l'état Yjs d'un document dans le snapshot REST
   * (champ `content`, S3-backed). Imite ce que fait le frontend BlockNote
   * dans son save loop de 60s.
   * / Persists the Yjs state to the REST snapshot. Mirrors the BlockNote
   * / 60s save loop in the browser frontend.
   *
   * Pourquoi : le serveur Hocuspocus de la-suite Docs n'a aucun mécanisme
   * de persistence côté backend. Tant qu'aucun client humain n'est connecté
   * et n'exécute SON save loop, le Y.Doc en mémoire serveur peut être
   * unloaded sans avoir été persisté — les writes du MCP sont alors perdus.
   * En appelant cet endpoint après chaque write Yjs, le MCP garantit la
   * persistance côté serveur, indépendamment de la présence humaine.
   * / Hocuspocus side has no persistence callback. Without an active
   * / browser client, MCP writes are lost when the doc is unloaded. This
   * / PATCH guarantees server-side persistence after each MCP write.
   *
   * Comportement quand non-authentifié : skip silencieusement (best-effort).
   * Le PATCH /content/ exige des credentials valides côté Django ; en mode
   * anonyme, on ne peut pas persister via cet endpoint et on doit compter
   * sur le save loop d'un humain connecté en parallèle.
   * / Silent skip when unauthenticated — the PATCH requires valid creds.
   */
  async patchDocumentContent(
    documentIdentifier: DocumentId,
    contentBase64: string,
    isConnectedToCollabServer: boolean,
  ): Promise<void> {
    if (!this.credentialsStore.has()) {
      // Mode anonyme : pas d'auth Django → PATCH refusé. On compte sur
      // un humain connecté pour déclencher la persistence côté serveur.
      // / Anonymous mode: no Django auth → PATCH refused. Rely on a human.
      return;
    }
    // L'écriture passe par PATCH sur la ressource document elle-même
    // (le serializer DRF Document accepte `content` dans le body), pas
    // par la sous-ressource /content/ qui est read-only sur cette instance.
    // / The write goes through PATCH on the document resource (the DRF
    // / serializer accepts `content`). The /content/ sub-resource is
    // / GET-only on this Docs instance.
    const url = this.buildAuthUrl(
      `/api/v1.0/documents/${documentIdentifier}/`,
    );
    await this.requestWithAuth(url, 'PATCH', {
      content: contentBase64,
      websocket: isConnectedToCollabServer,
    });
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
    // 401 vs 403 : on les traite séparément. Avant on les confondait sous
    // AUTH_REQUIRED, ce qui faisait remonter le tutoriel cookies à l'agent
    // alors que ses credentials étaient parfaitement valides — il n'a juste
    // pas le droit de faire CETTE opération sur CE doc.
    // / 401 = expired session, 403 = valid creds but operation forbidden.
    if (response.status === 401) {
      throw new DocsError(
        'AUTH_REQUIRED',
        this.buildAuthRequiredMessage('expired_or_invalid'),
      );
    }
    if (response.status === 403) {
      throw new DocsError(
        'PERMISSION_DENIED',
        await this.buildPermissionDeniedMessage(response, `${method} ${url}`),
      );
    }
    if (!response.ok) {
      throw new Error(
        `Unexpected response ${response.status} from ${method} ${url}`,
      );
    }
    return response;
  }

  /**
   * Construit le message d'erreur d'une 403, en récupérant si possible
   * le détail Django (clé "detail" dans la réponse JSON DRF) qui indique
   * souvent la permission précise refusée.
   * / Builds the 403 error message, including Django's "detail" field
   * / from the DRF response when available.
   */
  private async buildPermissionDeniedMessage(
    response: Response,
    operation: string,
  ): Promise<string> {
    let serverDetail = '';
    try {
      const body = (await response.clone().json()) as { detail?: string };
      if (body.detail) {
        serverDetail = `\nMessage du serveur : ${body.detail}`;
      }
    } catch {
      // Pas de body JSON exploitable — pas grave, on renvoie un message
      // générique. Django renvoie habituellement du JSON sur les 403 DRF
      // mais on protège contre les cas où ce serait du HTML.
      // / No usable JSON body — fall back to generic message.
    }
    return `Le serveur a refusé l'opération avec un code 403 (Forbidden) sur ${operation}.

Tes credentials sont valides — sinon tu aurais reçu un 401 (AUTH_REQUIRED). Mais l'utilisateur connecté n'a pas la permission précise nécessaire pour cette opération.

Causes fréquentes :
- Pour create_document avec parent_id : il faut la permission "children_create" sur le doc parent. Vérifie en navigateur si tu peux créer un sous-doc sous ce parent via l'UI.
- Pour delete_document, move_document, duplicate_document : permissions de gestion (destroy, manage) sur le doc.
- Pour update_block / insert_block / delete_block : ce sont des ops Yjs (WebSocket), pas REST — un 403 ici ne devrait pas arriver pour ces tools.${serverDetail}`;
  }

  private async postJson<T>(url: string, body: unknown): Promise<T> {
    const response = await this.requestWithAuth(url, 'POST', body);
    if (response.status === 204) {
      return undefined as unknown as T;
    }
    return (await response.json()) as T;
  }

  private buildAuthRequiredMessage(
    variant: 'missing' | 'expired_or_invalid' | 'invalid_at_set' = 'missing',
  ): string {
    let lead: string;
    if (variant === 'expired_or_invalid') {
      lead = 'Les credentials de session ont expiré ou sont invalides. Recolle-moi des nouvelles valeurs.';
    } else if (variant === 'invalid_at_set') {
      // Cas spécifique : on vient juste de poser des cookies via
      // set_session_credentials, et le ping /users/me/ a renvoyé 401/403.
      // Avant de renvoyer ce message, on a pris soin de clear les creds
      // côté MCP — donc l'état est propre, l'agent peut re-set.
      // / Specific to the post-set verification ping that came back 401/403.
      lead = `Les cookies que tu viens de me passer ne sont pas reconnus par le serveur Docs (GET /api/v1.0/users/me/ a retourné 401/403). Les credentials ont été automatiquement vidés côté MCP — tu n'es pas authentifié.

⚠️ Attention au piège qui peut être trompeur : beaucoup de docs Docs sont en lien public/editor, donc des tools comme read_document, insert_block, update_block et delete_block continuent de fonctionner SANS authentification (n'importe qui peut éditer). Si tu vois ces tools réussir avec des cookies morts, c'est l'accès anonyme via le lien public — pas tes credentials. Seul create_document (et les autres ops REST authentifiées : delete_document, move_document, etc.) révèle la mort de la session.

Causes fréquentes pour des cookies refusés :
- Mauvaise copie : espaces autour de la valeur, troncature, copie d'une autre ligne (csrftoken vs docs_sessionid mélangés).
- Cookies copiés depuis une autre instance Docs (vérifie le domaine dans DevTools).
- Session expirée entre la copie et le set (la session Docs vit ~12h, parfois moins selon l'instance).
- Déconnexion ailleurs : si tu te déconnectes dans un autre onglet/navigateur, la session est invalidée partout.`;
    } else {
      lead = 'Cette opération nécessite un cookie de session valide.';
    }
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
