import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requirePro } from "@/lib/auth";
import {
  emptyResponse,
  errorResponse,
  jsonResponse,
  operationIdHeaders,
  textResponse,
} from "@/lib/http";
import {
  createCollection,
  deleteCollection,
  listCollections,
} from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/collection
 * Lists the user's collections: `[{ id }, ...]`.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const context = await authenticateRequest(request);
    requirePro(context);
    const collections = await listCollections(context.uid);
    return jsonResponse(collections, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/v1/collection
 * Creates a collection and answers with its server-minted id (plain text).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const context = await authenticateRequest(request);
    requirePro(context);
    const id = await createCollection(context.uid);
    return textResponse(id, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

export function HEAD(): NextResponse {
  return new NextResponse(null, {
    status: 405,
    headers: operationIdHeaders(),
  });
}

/**
 * DELETE /api/v1/collection
 * Clears every collection of the user. The sync client invokes this base-path
 * delete when clearing cloud data; leaving it unimplemented answers 405
 * MethodNotFound and the client reports the method as unsupported.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const context = await authenticateRequest(request);
    requirePro(context);
    const collections = await listCollections(context.uid);
    for (const { id } of collections) {
      await deleteCollection(context.uid, id);
    }
    return emptyResponse(200);
  } catch (error) {
    return errorResponse(error);
  }
}
