// Backup file I/O on iOS / Android (Settings > Export / Import JSON). The
// payload itself comes from lib/backup.ts, byte-identical to the web export;
// this module only moves text between the app and the device. The web build
// uses backup-io.web.ts (Expo FileSystem has no web implementation).
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/** Result of a pick: the file text, or null when the user cancelled. */
export type PickedText = { name: string; text: string } | null;

/** Write the export to the cache dir and open the share sheet (Files, Mail, AirDrop...). */
export async function shareJson(filename: string, text: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  const file = new File(Paths.cache, filename);
  file.create({ overwrite: true });
  file.write(text);
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: 'Export Poker Analytics data' });
}

/** Let the user pick a JSON file and read it as text. */
export async function pickJsonText(): Promise<PickedText> {
  const res = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', '*/*'], copyToCacheDirectory: true });
  if (res.canceled) return null;
  const asset = res.assets[0];
  if (!asset) return null;
  const text = await new File(asset.uri).text();
  return { name: asset.name, text };
}
