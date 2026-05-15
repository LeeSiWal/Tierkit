export interface ExportFile {
  path: string;
  contents: string;
  encoding?: "utf8";
  pluginId?: string;
}

export interface ExportWarning {
  pluginId?: string;
  message: string;
}

export interface ExportResult {
  target: string;
  files: ExportFile[];
  warnings: ExportWarning[];
}
