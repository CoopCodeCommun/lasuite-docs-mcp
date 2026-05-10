/**
 * Cache des sessions Yjs ouvertes par doc_id, avec TTL de garbage collection.
 * / Cache of open Yjs sessions per doc_id, with garbage collection TTL.
 *
 * LOCALISATION : src/docs/session.ts
 *
 * Quand un tool MCP est appelé, ce module fournit le Y.Doc déjà synchronisé
 * pour ce document, ou ouvre une nouvelle connexion Hocuspocus si pas en cache.
 * Une fois inactif pendant plus de DOCS_SESSION_TTL_MS, la connexion est fermée.
 *
 * FLUX (getOrCreate) :
 * 1. server.ts appelle getOrCreate(docId)
 * 2. Si cache hit : retourne la session, met à jour lastUsed
 * 3. Si cache miss : ouvre la WS via DocsWebSocket, attend onSynced
 * 4. Le timer GC (toutes les 60s) ferme les sessions inactives
 *
 * COMMUNICATION :
 * Reçoit : appels depuis server.ts (un par tool call)
 * Émet : updates Yjs vers le serveur Hocuspocus (via Y.Doc.transact)
 */

import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from '@hocuspocus/provider';
import * as Y from 'yjs';
import { createDocsWebSocketClass } from './connection.js';
import { appendInlineMarkdownToParent } from './markdown.js';
import { DocsError } from '../types.js';
import type { DocumentId } from '../types.js';
import type { CredentialsStore } from '../auth/credentials.js';
import type { DocsRestClient } from './client.js';

/**
 * Représentation interne d'une session Yjs ouverte.
 * / Internal representation of an open Yjs session.
 */
interface OpenYjsSession {
  yjsDocument: Y.Doc;
  hocuspocusProvider: HocuspocusProvider;
  websocketProvider: HocuspocusProviderWebsocket;
  lastUsedTimestamp: number;
}

/**
 * Manager des sessions Yjs en cache. Une instance par serveur MCP.
 * / Yjs session cache manager. One instance per MCP server.
 */
export class SessionManager {
  private readonly openSessionsByDocId = new Map<DocumentId, OpenYjsSession>();
  private readonly garbageCollectionInterval: NodeJS.Timeout;
  private readonly docsWebSocketClass: ReturnType<
    typeof createDocsWebSocketClass
  >;

  constructor(
    private readonly docsInstanceUrl: string,
    private readonly sessionTtlMs: number,
    private readonly syncTimeoutMs: number,
    credentialsStore?: CredentialsStore,
    // Optionnel : si fourni, sert à hydrater le Y.Doc local depuis le
    // snapshot REST AVANT d'ouvrir la WebSocket Hocuspocus. Sans cette
    // hydratation, on récupère un Y.Doc vide quand aucun autre client
    // (humain ou bot) n'est déjà connecté au doc — le serveur Hocuspocus
    // de la-suite Docs ne charge pas le snapshot REST tout seul.
    // / Optional: if provided, used to seed the local Y.Doc from the REST
    // / snapshot before opening the Hocuspocus WS.
    private readonly docsRestClient?: DocsRestClient,
  ) {
    this.docsWebSocketClass = createDocsWebSocketClass(
      docsInstanceUrl,
      credentialsStore,
    );
    // Lance le GC toutes les 60 secondes pour fermer les sessions inactives.
    // / Run GC every 60s to close inactive sessions.
    this.garbageCollectionInterval = setInterval(() => {
      this.closeInactiveSessions();
    }, 60_000);
    // Empêche le timer de bloquer la fermeture du process.
    // / Don't keep the process alive just for this timer.
    this.garbageCollectionInterval.unref();
  }

  /**
   * Retourne la session pour `documentIdentifier`. L'ouvre et la synchronise
   * si elle n'est pas déjà en cache. Met à jour lastUsedTimestamp.
   * / Returns the session for `documentIdentifier`. Opens and syncs it
   * if not already cached. Updates lastUsedTimestamp.
   */
  async getOrCreate(documentIdentifier: DocumentId): Promise<OpenYjsSession> {
    const cachedSession = this.openSessionsByDocId.get(documentIdentifier);
    if (cachedSession) {
      cachedSession.lastUsedTimestamp = Date.now();
      return cachedSession;
    }

    // Cache miss : ouvre une nouvelle connexion Hocuspocus.
    // / Cache miss: open a new Hocuspocus connection.
    const newSession = await this.openNewSession(documentIdentifier);
    this.openSessionsByDocId.set(documentIdentifier, newSession);
    return newSession;
  }

  /**
   * Ouvre une connexion WS Hocuspocus pour `documentIdentifier` et attend
   * la synchronisation initiale (au max syncTimeoutMs).
   * / Opens a Hocuspocus WS connection and waits for initial sync.
   */
  private async openNewSession(
    documentIdentifier: DocumentId,
  ): Promise<OpenYjsSession> {
    const yjsDocument = new Y.Doc({ guid: documentIdentifier });

    // Hydrate le Y.Doc local depuis le snapshot REST avant la WebSocket.
    // C'est ce que fait le frontend BlockNote dans le navigateur : il
    // GET le doc en REST, applique le binaire Yjs (champ `content`) sur
    // son Y.Doc local, puis ouvre la WS. Sans ça, si le serveur Hocuspocus
    // n'a personne d'autre sur le doc, il instancie un Y.Doc vide et nous
    // sync ce vide — on perd les 47 paragraphes existants côté serveur.
    // Yjs étant un CRDT, l'hydratation locale + sync WS fusionneront sans
    // conflit même si un autre client est déjà connecté.
    // / Seed the local Y.Doc from the REST snapshot before connecting the
    // / WebSocket. Mirrors what BlockNote does in the browser. Hocuspocus
    // / does not hydrate the collaborative Y.Doc from REST on its own
    // / when no other client is connected.
    await this.hydrateFromRestSnapshot(documentIdentifier, yjsDocument);

    // Construit l'URL WebSocket à partir de l'URL HTTPS de l'instance.
    // / Build WS URL from instance HTTPS URL.
    const websocketUrl = this.buildWebSocketUrl(documentIdentifier);

    const websocketProvider = new HocuspocusProviderWebsocket({
      url: websocketUrl,
      WebSocketPolyfill: this.docsWebSocketClass as unknown as typeof WebSocket,
    });

    const hocuspocusProvider = new HocuspocusProvider({
      websocketProvider,
      name: documentIdentifier,
      document: yjsDocument,
      // Token bidon : nécessaire pour que le client envoie l'AuthenticationMessage.
      // / Dummy token: required so the client sends AuthenticationMessage.
      token: 'notoken',
    });

    // Attend onSynced ou timeout.
    // / Wait for onSynced or timeout.
    await this.waitForInitialSync(hocuspocusProvider, documentIdentifier);

    return {
      yjsDocument,
      hocuspocusProvider,
      websocketProvider,
      lastUsedTimestamp: Date.now(),
    };
  }

  /**
   * Hydrate un Y.Doc neuf à partir du snapshot REST du serveur Docs.
   * / Hydrate a fresh Y.Doc from the Docs REST snapshot.
   *
   * Le serveur Hocuspocus de la-suite Docs ne charge PAS automatiquement
   * le contenu Yjs depuis la base quand un client se connecte sur un doc
   * "froid" (aucun autre client sur le doc). Il instancie un Y.Doc vide
   * et sync ce vide. Pour que le MCP voit le contenu réel, il faut donc
   * d'abord récupérer le snapshot REST (champ `content`, base64 Yjs
   * binaire) et l'appliquer sur notre Y.Doc local.
   *
   * Comportement défensif : si le client REST n'est pas configuré, ou si
   * le fetch échoue (réseau, 404, 401/403), on continue sans hydrater.
   * Le sync WS qui suit pourra peut-être quand même charger du contenu
   * (cas où un autre client est connecté en parallèle), ou échouer
   * proprement si on n'a pas accès au doc.
   * / Defensive: if REST fetch fails, continue without hydration.
   */
  private async hydrateFromRestSnapshot(
    documentIdentifier: DocumentId,
    yjsDocument: Y.Doc,
  ): Promise<void> {
    if (!this.docsRestClient) {
      return;
    }
    let documentMetadata;
    try {
      documentMetadata = await this.docsRestClient.fetchDocumentMetadata(
        documentIdentifier,
      );
    } catch {
      // On laisse le sync WS gérer l'erreur (auth, 404, etc.) avec ses
      // propres codes. L'hydratation est best-effort.
      // / Let the WS sync handle the error with its own error codes.
      return;
    }
    const contentBase64 = documentMetadata.content;
    if (!contentBase64) {
      // Doc sans contenu : Y.Doc reste vide, c'est l'état attendu.
      // / Empty doc: leave the Y.Doc empty.
      return;
    }
    // Décode le base64 en binaire Yjs et applique sur le Y.Doc local.
    // Y.applyUpdate est idempotent et CRDT-safe : si le sync WS qui
    // suit reçoit un état différent, Yjs converge sans conflit.
    // / Decode base64 to Yjs binary and apply to local Y.Doc. CRDT-safe.
    const updateBinary = Buffer.from(contentBase64, 'base64');
    Y.applyUpdate(yjsDocument, new Uint8Array(updateBinary));
  }

  /**
   * Construit l'URL WebSocket Hocuspocus pour un doc donné.
   * / Builds the Hocuspocus WebSocket URL for a given doc.
   *
   * Format : wss://<host>/collaboration/ws/?room=<doc_id>
   */
  private buildWebSocketUrl(documentIdentifier: DocumentId): string {
    const httpsUrl = new URL(this.docsInstanceUrl);
    const websocketProtocol = httpsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${websocketProtocol}//${httpsUrl.host}/collaboration/ws/?room=${documentIdentifier}`;
  }

  /**
   * Attend l'événement onSynced du provider Hocuspocus, ou timeout après
   * syncTimeoutMs. Lance DocsError(SYNC_TIMEOUT) en cas de timeout.
   * / Waits for the provider's onSynced event, or times out.
   */
  private async waitForInitialSync(
    hocuspocusProvider: HocuspocusProvider,
    documentIdentifier: DocumentId,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Si déjà synced (cas improbable mais défensif).
      // / If already synced (defensive).
      if (hocuspocusProvider.synced) {
        resolve();
        return;
      }

      const timeoutHandle = setTimeout(() => {
        hocuspocusProvider.off('synced', onSyncedCallback);
        reject(
          new DocsError(
            'SYNC_TIMEOUT',
            `Sync timeout for document ${documentIdentifier} after ${this.syncTimeoutMs}ms`,
          ),
        );
      }, this.syncTimeoutMs);

      const onSyncedCallback = () => {
        clearTimeout(timeoutHandle);
        resolve();
      };

      hocuspocusProvider.on('synced', onSyncedCallback);
    });
  }

  /**
   * Ferme toutes les sessions inactives depuis plus de sessionTtlMs.
   * / Closes all sessions inactive for more than sessionTtlMs.
   */
  private closeInactiveSessions(): void {
    const currentTimestamp = Date.now();
    for (const [documentIdentifier, openSession] of this.openSessionsByDocId) {
      const inactivityDurationMs =
        currentTimestamp - openSession.lastUsedTimestamp;
      if (inactivityDurationMs > this.sessionTtlMs) {
        this.closeSession(documentIdentifier, openSession);
      }
    }
  }

  /**
   * Ferme une session : déconnecte le provider, retire de la map.
   * / Closes a session: disconnect provider, remove from map.
   */
  private closeSession(
    documentIdentifier: DocumentId,
    openSession: OpenYjsSession,
  ): void {
    // 1. Déconnecte et détruit le provider Hocuspocus.
    // / Disconnect and destroy the Hocuspocus provider.
    openSession.hocuspocusProvider.disconnect();
    openSession.hocuspocusProvider.destroy();

    // 2. Détruit explicitement le sous-provider WebSocket pour garantir
    //    que le socket est fermé proprement. HocuspocusProvider.destroy()
    //    ne le fait pas explicitement.
    // / Explicitly destroy the WebSocket sub-provider so the underlying
    // / socket is closed cleanly. HocuspocusProvider.destroy() does not.
    openSession.websocketProvider.destroy();

    this.openSessionsByDocId.delete(documentIdentifier);
  }

  /**
   * Lit la liste des blocs d'un document.
   * / Reads the block list of a document.
   */
  async readDocument(documentIdentifier: DocumentId) {
    const openSession = await this.getOrCreate(documentIdentifier);
    const documentFragment = openSession.yjsDocument.getXmlFragment(
      'document-store',
    );
    const { xmlFragmentToBlocks } = await import('./blocks.js');
    return xmlFragmentToBlocks(documentFragment);
  }

  /**
   * Insère un nouveau bloc dans le document.
   * Si afterBlockIdentifier est null/undefined, insertion en tête.
   * Sinon, insertion juste après le bloc avec cet id.
   * / Inserts a new block. After-id null = insert at start.
   */
  async insertBlock(
    documentIdentifier: DocumentId,
    blockContent: BlockContentArg,
    afterBlockIdentifier: BlockId | null,
  ): Promise<BlockId> {
    const openSession = await this.getOrCreate(documentIdentifier);
    const documentFragment = openSession.yjsDocument.getXmlFragment(
      'document-store',
    );
    const {
      buildBlockContainer,
      findOrCreateTopLevelBlockGroup,
      findBlockContainerIndex,
      populateInlineContent,
    } = await import('./blocks.js');

    let newBlockIdentifier = '';

    openSession.yjsDocument.transact(() => {
      const topLevelBlockGroup = findOrCreateTopLevelBlockGroup(documentFragment);
      // 1. Construit le blockContainer + son content element vide
      //    (paragraph/heading sans contenu inline).
      // / Build empty blockContainer + content element (no inline yet).
      const builtBlockContainer = buildBlockContainer(blockContent);

      const insertionIndex = computeInsertionIndex(
        documentFragment,
        afterBlockIdentifier,
        findBlockContainerIndex,
      );
      // 2. Attache le blockContainer au blockGroup (qui est déjà dans le doc).
      // / Attach blockContainer to blockGroup (already in doc).
      topLevelBlockGroup.insert(insertionIndex, [builtBlockContainer]);

      // 3. MAINTENANT que tout est attaché au doc, on peut appliquer les
      //    marks Yjs (gras, italique, code, strike) sur les Y.XmlText et
      //    insérer des <link> enfants. Sur un élément détaché, ça lèverait
      //    "Invalid access: Add Yjs type to a document before reading data".
      // / NOW that everything is attached, apply Yjs marks and insert <link>.
      populateInlineContent(builtBlockContainer, blockContent.text);

      // 4. Lit l'attribut id APRÈS l'intégration. Avant l'insert dans le
      //    blockGroup, les attributs vivent dans _prelimAttrs et getAttribute
      //    retourne undefined (limitation Yjs 13.6.x).
      // / Read id AFTER integration (Yjs _prelimAttrs constraint).
      newBlockIdentifier = builtBlockContainer.getAttribute('id') ?? '';
    });

    // Attend que l'update soit propagé au serveur Hocuspocus avant de
    // retourner. Sans ce flush, un process MCP qui termine vite (ex: un
    // appel JSON-RPC unique sur stdio) peut perdre l'update : la
    // transaction Yjs locale réussit, on retourne le block_id, mais le
    // socket WebSocket se ferme avant l'envoi.
    // / Wait for update to propagate to Hocuspocus before returning.
    // / Without this, a short-lived MCP process can drop the update.
    await this.awaitFlush(openSession.hocuspocusProvider);

    // Persiste l'état complet du Y.Doc dans le snapshot REST. Sans ça,
    // l'update est seulement en mémoire Hocuspocus — il sera perdu quand
    // le serveur unloade le doc (au départ du dernier client). Skip
    // silencieux en mode anonyme.
    // / Persist the full Y.Doc state to the REST snapshot. Otherwise the
    // / update lives only in Hocuspocus memory and is lost on unload.
    await this.persistContentToRest(documentIdentifier, openSession.yjsDocument);

    return newBlockIdentifier;
  }

  /**
   * Insère un bloc image dans le document. Le caller a déjà uploadé le
   * fichier via DocsRestClient.uploadAttachment et nous passe l'URL.
   * / Inserts an image block. The caller has already uploaded the file
   * / via uploadAttachment and provides the URL.
   */
  async insertImageBlock(
    documentIdentifier: DocumentId,
    imageProperties: { url: string; name: string; caption?: string },
    afterBlockIdentifier: BlockId | null,
  ): Promise<BlockId> {
    const openSession = await this.getOrCreate(documentIdentifier);
    const documentFragment = openSession.yjsDocument.getXmlFragment(
      'document-store',
    );
    const {
      buildImageBlockContainer,
      findOrCreateTopLevelBlockGroup,
      findBlockContainerIndex,
    } = await import('./blocks.js');

    let newBlockIdentifier = '';

    openSession.yjsDocument.transact(() => {
      const topLevelBlockGroup = findOrCreateTopLevelBlockGroup(documentFragment);
      const builtBlockContainer = buildImageBlockContainer(imageProperties);
      const insertionIndex = computeInsertionIndex(
        documentFragment,
        afterBlockIdentifier,
        findBlockContainerIndex,
      );
      topLevelBlockGroup.insert(insertionIndex, [builtBlockContainer]);
      // L'image n'a pas de Y.XmlText à peupler — toutes les infos sont
      // dans les attributs posés par buildImageBlockContainer.
      // / No Y.XmlText to populate — image info is in attributes.
      newBlockIdentifier = builtBlockContainer.getAttribute('id') ?? '';
    });

    await this.awaitFlush(openSession.hocuspocusProvider);
    await this.persistContentToRest(documentIdentifier, openSession.yjsDocument);

    return newBlockIdentifier;
  }

  /**
   * Remplace le texte d'un bloc existant.
   * / Replaces the text of an existing block.
   */
  async updateBlockText(
    documentIdentifier: DocumentId,
    blockIdentifier: BlockId,
    newText: string,
  ): Promise<void> {
    const openSession = await this.getOrCreate(documentIdentifier);
    const documentFragment = openSession.yjsDocument.getXmlFragment(
      'document-store',
    );
    const { findBlockContainerById } = await import('./blocks.js');

    const targetContainer = findBlockContainerById(
      documentFragment,
      blockIdentifier,
    );
    if (!targetContainer) {
      throw new DocsError(
        'BLOCK_NOT_FOUND',
        `Block ${blockIdentifier} not found in document ${documentIdentifier}`,
      );
    }

    // Vérifie l'élément de contenu AVANT d'ouvrir la transaction.
    // Si on jetait l'exception dans transact(), Yjs pourrait la swallowner
    // silencieusement, et l'agent ne saurait jamais que l'op a échoué.
    // / Check the content element BEFORE opening the transaction.
    // / Yjs may swallow exceptions thrown inside transact() — that would
    // / cause silent failures. Validate first, mutate second.
    const contentElement = findFirstNonBlockGroupChild(targetContainer);
    if (!contentElement) {
      throw new DocsError(
        'UNSUPPORTED_BLOCK_TYPE',
        `Block ${blockIdentifier} has no content element`,
      );
    }

    openSession.yjsDocument.transact(() => {
      replaceTextInElement(contentElement, newText);
    });

    // Flush pour garantir la propagation au serveur (cf. insertBlock).
    // / Flush to guarantee server propagation (see insertBlock).
    await this.awaitFlush(openSession.hocuspocusProvider);

    // Persistence explicite vers le snapshot REST (cf. insertBlock).
    // / Explicit persistence to the REST snapshot.
    await this.persistContentToRest(documentIdentifier, openSession.yjsDocument);
  }

  /**
   * Supprime un bloc du document.
   * / Deletes a block from the document.
   */
  async deleteBlock(
    documentIdentifier: DocumentId,
    blockIdentifier: BlockId,
  ): Promise<void> {
    const openSession = await this.getOrCreate(documentIdentifier);
    const documentFragment = openSession.yjsDocument.getXmlFragment(
      'document-store',
    );
    const { findBlockContainerIndex } = await import('./blocks.js');

    const blockIndex = findBlockContainerIndex(
      documentFragment,
      blockIdentifier,
    );
    if (blockIndex === -1) {
      throw new DocsError(
        'BLOCK_NOT_FOUND',
        `Block ${blockIdentifier} not found in document ${documentIdentifier}`,
      );
    }

    openSession.yjsDocument.transact(() => {
      const topLevelBlockGroup = documentFragment
        .toArray()
        .find(
          (n) =>
            n instanceof Y.XmlElement && n.nodeName === 'blockGroup',
        ) as Y.XmlElement | undefined;
      if (topLevelBlockGroup) {
        topLevelBlockGroup.delete(blockIndex, 1);
      }
    });

    // Flush pour garantir la propagation au serveur (cf. insertBlock).
    // / Flush to guarantee server propagation (see insertBlock).
    await this.awaitFlush(openSession.hocuspocusProvider);

    // Persistence explicite vers le snapshot REST (cf. insertBlock).
    // / Explicit persistence to the REST snapshot.
    await this.persistContentToRest(documentIdentifier, openSession.yjsDocument);
  }

  /**
   * Persiste l'état complet du Y.Doc dans le snapshot REST de Docs via
   * PATCH /api/v1.0/documents/{id}/content/. Imite ce que fait le
   * frontend BlockNote dans son save loop.
   * / Persists the full Y.Doc state to the REST snapshot.
   *
   * Pourquoi : Hocuspocus côté serveur Docs n'a aucune persistence
   * automatique. Sans ce PATCH, les writes du MCP restent uniquement
   * dans la RAM serveur tant qu'aucun humain ne déclenche son save
   * loop côté navigateur. Si Hocuspocus unload le doc avant, les
   * writes sont perdus, et le prochain humain qui ouvre le doc
   * réhydrate depuis un snapshot REST stale qui ne contient pas
   * les writes du MCP.
   * / Hocuspocus has no built-in persistence. Without this PATCH,
   * / MCP writes are lost on doc unload if no human is active.
   *
   * Comportement quand on n'a pas de DocsRestClient configuré, ou
   * quand le client REST est en mode anonyme : skip silencieux. La
   * persistence retombe alors sur le save loop des humains
   * potentiellement connectés.
   * / Silent skip if no REST client or anonymous mode.
   */
  private async persistContentToRest(
    documentIdentifier: DocumentId,
    yjsDocument: Y.Doc,
  ): Promise<void> {
    if (!this.docsRestClient) {
      return;
    }
    // Encode l'état complet du Y.Doc en binaire Yjs, puis en base64.
    // C'est exactement le format attendu par le PATCH /content/.
    // / Encode full Y.Doc state as Yjs binary, then base64.
    const stateBinary = Y.encodeStateAsUpdate(yjsDocument);
    const stateBase64 = Buffer.from(stateBinary).toString('base64');
    // Le flag `websocket: true` signale au backend Django qu'on est
    // bien connecté au serveur de collab — sinon Django peut considérer
    // le PATCH comme suspect (cf. setting COLLABORATION_WS_NOT_CONNECTED_READY_ONLY).
    // / `websocket: true` tells Django we are connected to collab WS.
    await this.docsRestClient.patchDocumentContent(
      documentIdentifier,
      stateBase64,
      true,
    );
  }

  /**
   * Attend que tous les updates locaux aient été propagés au serveur
   * Hocuspocus avant de retourner. Évite la race condition où un process
   * MCP éphémère termine sur EOF stdin avant que la WebSocket ait flushé.
   * / Waits for all local updates to propagate to the Hocuspocus server.
   * / Avoids race condition on short-lived MCP processes.
   *
   * Mécanisme : le HocuspocusProvider expose `hasUnsyncedChanges` (booléen)
   * et émet l'event `unsyncedChanges` à chaque incrément/décrément du
   * compteur interne. Le compteur revient à 0 quand le serveur a ack tous
   * les updates en cours.
   */
  private async awaitFlush(
    hocuspocusProvider: HocuspocusProvider,
    timeoutMs: number = 5_000,
  ): Promise<void> {
    if (!hocuspocusProvider.hasUnsyncedChanges) {
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const onUnsyncedChange = (count: number) => {
        if (count === 0) {
          hocuspocusProvider.off('unsyncedChanges', onUnsyncedChange);
          clearTimeout(timeoutHandle);
          resolve();
        }
      };
      const timeoutHandle = setTimeout(() => {
        hocuspocusProvider.off('unsyncedChanges', onUnsyncedChange);
        reject(
          new DocsError(
            'SYNC_TIMEOUT',
            `Hocuspocus flush timeout after ${timeoutMs}ms — l'update local n'a pas été propagé au serveur dans les temps.`,
          ),
        );
      }, timeoutMs);
      hocuspocusProvider.on('unsyncedChanges', onUnsyncedChange);
    });
  }

  /**
   * Ferme toutes les sessions et arrête le GC. À appeler au shutdown.
   * / Closes all sessions and stops GC. Call on shutdown.
   */
  shutdown(): void {
    clearInterval(this.garbageCollectionInterval);
    for (const [documentIdentifier, openSession] of this.openSessionsByDocId) {
      this.closeSession(documentIdentifier, openSession);
    }
  }
}

/**
 * Type local dupliqué de BlockContent dans types.ts pour limiter le couplage
 * direct entre session.ts et types.ts dans la signature de insertBlock.
 * Si types.ts::BlockContent change, garder cette définition synchronisée.
 * / Local duplicate of BlockContent from types.ts to limit direct coupling.
 * / Keep in sync if types.ts changes.
 */
type BlockContentArg =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: 1 | 2 | 3; text: string };

type BlockId = string;

/**
 * Calcule l'index où insérer un nouveau bloc dans le blockGroup.
 * Si afterBlockIdentifier est null, retourne 0 (insertion en tête).
 * Sinon, retourne l'index du bloc cible + 1.
 * Si le bloc cible n'existe pas, lève BLOCK_NOT_FOUND.
 * / Computes insertion index in the blockGroup.
 */
function computeInsertionIndex(
  documentFragment: Y.XmlFragment,
  afterBlockIdentifier: BlockId | null,
  findBlockContainerIndexFn: (
    fragment: Y.XmlFragment,
    id: BlockId,
  ) => number,
): number {
  if (afterBlockIdentifier === null || afterBlockIdentifier === undefined) {
    return 0;
  }
  const targetIndex = findBlockContainerIndexFn(
    documentFragment,
    afterBlockIdentifier,
  );
  if (targetIndex === -1) {
    throw new DocsError(
      'BLOCK_NOT_FOUND',
      `Block ${afterBlockIdentifier} not found (cannot insert after)`,
    );
  }
  return targetIndex + 1;
}

/**
 * Trouve le premier enfant non-blockGroup d'un blockContainer.
 * / Finds the first non-blockGroup child of a blockContainer.
 */
function findFirstNonBlockGroupChild(
  blockContainerElement: Y.XmlElement,
): Y.XmlElement | null {
  for (const childElement of blockContainerElement.toArray()) {
    if (
      childElement instanceof Y.XmlElement &&
      childElement.nodeName !== 'blockGroup'
    ) {
      return childElement;
    }
  }
  return null;
}

/**
 * Remplace tout le texte d'un élément (paragraph, heading, etc.).
 * Supprime les Y.XmlText existants et en insère un seul nouveau.
 * Doit être appelé dans une transaction.
 * / Replaces the full text of an element. Call inside a transaction.
 */
function replaceTextInElement(
  parentElement: Y.XmlElement,
  newMarkdownInline: string,
): void {
  // v0.3 : on supprime TOUS les enfants existants (Y.XmlText et autres,
  // notamment les <link> qu'on a pu insérer auparavant), puis on
  // ré-insère le contenu inline parsé en markdown.
  // / v0.3: delete ALL existing children (Y.XmlText and <link> elements),
  // / then re-insert the markdown-parsed inline content.

  // 1. Supprime tous les enfants existants (du dernier au premier).
  // / Delete all existing children (last to first).
  const childCount = parentElement.length;
  for (let reverseIndex = childCount - 1; reverseIndex >= 0; reverseIndex--) {
    parentElement.delete(reverseIndex, 1);
  }

  // 2. Insère le nouveau contenu via le parser markdown inline.
  // / Insert the new content via inline markdown parser.
  appendInlineMarkdownToParent(parentElement, newMarkdownInline);
}
