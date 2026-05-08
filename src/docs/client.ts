/**
 * Wrapper REST sur l'API Django de la-suite Docs.
 * / REST wrapper over the la-suite Docs Django API.
 *
 * LOCALISATION : src/docs/client.ts
 *
 * Sert exclusivement aux opérations qui ne passent PAS par le WebSocket
 * Yjs : lister les docs accessibles, vérifier qu'un doc est public+editor,
 * récupérer ses métadonnées sans charger le contenu Yjs.
 *
 * COMMUNICATION :
 * Importé par : server.ts (pour list_documents et get_document_metadata).
 */

import { DocsError } from '../types.js';
import type { DocumentId, DocumentSummary } from '../types.js';

/**
 * Client REST minimal pour l'API Docs.
 * / Minimal REST client for the Docs API.
 */
export class DocsRestClient {
  constructor(private readonly docsInstanceUrl: string) {}

  /**
   * Récupère les métadonnées d'un document.
   * Lance DocsError(DOC_NOT_FOUND) en 404, DOC_NOT_PUBLIC si pas public.
   * / Fetches document metadata.
   */
  async fetchDocumentMetadata(
    documentIdentifier: DocumentId,
  ): Promise<DocumentSummary & { created_at: string }> {
    const apiResponse = await fetch(
      `${this.docsInstanceUrl}/api/v1.0/documents/${documentIdentifier}/`,
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

    if (documentData.link_reach !== 'public') {
      throw new DocsError(
        'DOC_NOT_PUBLIC',
        `Document ${documentIdentifier} is not public (link_reach=${documentData.link_reach})`,
      );
    }

    return documentData;
  }

  /**
   * Vérifie qu'un doc est public ET éditable. Lance DocsError sinon.
   * / Verifies the doc is public AND editable.
   */
  async assertPublicEditor(documentIdentifier: DocumentId): Promise<void> {
    const documentMetadata = await this.fetchDocumentMetadata(
      documentIdentifier,
    );
    if (documentMetadata.link_role !== 'editor') {
      throw new DocsError(
        'DOC_READONLY',
        `Document ${documentIdentifier} is public but read-only (link_role=${documentMetadata.link_role})`,
      );
    }
  }

  /**
   * Liste les docs publics accessibles.
   * Note : l'API Docs ne propose pas de filtre serveur sur link_reach,
   * on filtre côté client après la récupération.
   * / Lists public docs accessible by the instance.
   */
  async listPublicDocuments(): Promise<DocumentSummary[]> {
    const apiResponse = await fetch(
      `${this.docsInstanceUrl}/api/v1.0/documents/?page_size=100`,
    );
    if (!apiResponse.ok) {
      throw new Error(
        `Unexpected response ${apiResponse.status} when listing documents`,
      );
    }

    const responseBody = (await apiResponse.json()) as {
      results: Array<DocumentSummary>;
    };

    // Filtre côté client : on ne garde que les docs publics.
    // / Client-side filter: keep only public docs.
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
}
