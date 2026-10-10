// Backup file I/O for the Expo web build: a Blob download for export and the
// document picker's web File for import (Expo FileSystem is native-only).
import * as DocumentPicker from 'expo-document-picker';

export type PickedText = { name: string; text: string } | null;

export async function shareJson(filename: string, text: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function pickJsonText(): Promise<PickedText> {
  const res = await DocumentPicker.getDocumentAsync({ type: ['application/json', '.json'] });
  if (res.canceled) return null;
  const asset = res.assets[0];
  if (!asset) return null;
  const text = asset.file ? await asset.file.text() : await (await fetch(asset.uri)).text();
  return { name: asset.name, text };
}
