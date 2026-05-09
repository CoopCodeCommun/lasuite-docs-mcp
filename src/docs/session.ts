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
import { DocsError } from '../types.js';
import type { DocumentId } from '../types.js';
import type { CredentialsStore } from '../auth/credentials.js';

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
    } = await import('./blocks.js');

    let newBlockIdentifier = '';

    openSession.yjsDocument.transact(() => {
      const topLevelBlockGroup = findOrCreateTopLevelBlockGroup(documentFragment);
      const builtBlockContainer = buildBlockContainer(blockContent);

      const insertionIndex = computeInsertionIndex(
        documentFragment,
        afterBlockIdentifier,
        findBlockContainerIndex,
      );
      topLevelBlockGroup.insert(insertionIndex, [builtBlockContainer]);

      // Lit l'attribut id APRÈS l'intégration. Avant l'insert dans le
      // blockGroup, les attributs vivent dans _prelimAttrs et getAttribute
      // retourne undefined (limitation Yjs 13.6.x).
      // / Read the id attribute AFTER integration. Before the blockGroup
      // / insert, attributes live in _prelimAttrs and getAttribute returns
      // / undefined (Yjs 13.6.x constraint).
      newBlockIdentifier = builtBlockContainer.getAttribute('id') ?? '';
    });

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
  newText: string,
): void {
  // 1. Identifie tous les Y.XmlText enfants à supprimer.
  // / Identify all Y.XmlText children to delete.
  const childArray = parentElement.toArray();
  const textNodeIndices: number[] = [];
  for (let nodeIndex = 0; nodeIndex < childArray.length; nodeIndex++) {
    if (childArray[nodeIndex] instanceof Y.XmlText) {
      textNodeIndices.push(nodeIndex);
    }
  }

  // 2. Supprime les Y.XmlText du dernier au premier (pour ne pas décaler).
  // / Delete Y.XmlText from last to first (so indices don't shift).
  for (let reverseIndex = textNodeIndices.length - 1; reverseIndex >= 0; reverseIndex--) {
    parentElement.delete(textNodeIndices[reverseIndex], 1);
  }

  // 3. Insère un nouveau Y.XmlText avec le texte de remplacement.
  // / Insert a new Y.XmlText with the replacement text.
  const newTextNode = new Y.XmlText();
  newTextNode.insert(0, newText);
  parentElement.insert(0, [newTextNode]);
}
