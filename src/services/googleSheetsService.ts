import { safeParseJsonResponse } from '../utils/apiUtils';

export interface SheetReadResult {
  success: boolean;
  spreadsheetUrl: string;
  range: string;
  values: string[][];
  tabExists?: boolean;
  fetchedAt: string;
}

export interface SheetSyncResult {
  success: boolean;
  updatedRows: number;
  updatedCells: number;
  syncedAt: string;
  spreadsheetUrl: string;
  created?: boolean;
}

function getSessionToken(): string {
  try {
    return JSON.parse(localStorage.getItem('mvp_finance_session') || '{}').sessionToken || '';
  } catch {
    return '';
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = getSessionToken();
  if (!token) throw new Error('Please log in to access the shared Google Sheet.');
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const data = await safeParseJsonResponse(response);
  if (!response.ok || data.success === false) throw new Error(data.error || `Google Sheets request failed (${response.status})`);
  return data as T;
}

class GoogleSheetsService {
  public async getSheetValues(): Promise<SheetReadResult> {
    return request<SheetReadResult>('/api/sheets/values');
  }

  public async syncRecords(): Promise<SheetSyncResult> {
    return request<SheetSyncResult>('/api/sheets/sync', { method: 'POST', body: JSON.stringify({}) });
  }

  public async createSheet(): Promise<SheetSyncResult> {
    return request<SheetSyncResult>('/api/sheets/create', { method: 'POST', body: JSON.stringify({}) });
  }
}

export const googleSheetsService = new GoogleSheetsService();
