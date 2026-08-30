"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { generateFileFingerprint } from "@/lib/uploads/fingerprint";
import {
  getUploadSession,
  type StoredUploadSession,
} from "@/lib/uploads/resume-store";
import {
  uploadVideo,
  cancelUpload,
  type UploadProgress,
  type UploadResult,
} from "@/lib/uploads/upload-coordinator";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function VideoUploader() {
  const [file, setFile] = React.useState<File | null>(null);
  const [resumableSession, setResumableSession] =
    React.useState<StoredUploadSession | null>(null);
  const [progress, setProgress] = React.useState<UploadProgress | null>(null);
  const [result, setResult] = React.useState<UploadResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isUploading, setIsUploading] = React.useState(false);

  const abortControllerRef = React.useRef<AbortController | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    setError(null);
    setResult(null);
    setProgress(null);

    const fp = generateFileFingerprint(selected);
    try {
      const stored = await getUploadSession(fp);
      if (stored && stored.uploadedParts.length > 0) {
        setResumableSession(stored);
      } else {
        setResumableSession(null);
      }
    } catch {
      setResumableSession(null);
    }
  };

  const handleStartUpload = async () => {
    if (!file) return;

    setIsUploading(true);
    setError(null);
    setResult(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const uploadRes = await uploadVideo(file, {
        onProgress: (p) => {
          setProgress(p);
          if (p.stage === "failed" && p.error) {
            setError(p.error);
          }
        },
        signal: controller.signal,
      });

      setResult(uploadRes);
      setResumableSession(null);
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        setError("Envio cancelado.");
      } else {
        const msg =
          err instanceof Error ? err.message : "Ocorreu um erro durante o envio.";
        setError(msg);
      }
    } finally {
      setIsUploading(false);
      abortControllerRef.current = null;
    }
  };

  const handleCancel = async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (resumableSession && file) {
      const fp = generateFileFingerprint(file);
      await cancelUpload(resumableSession.sessionId, fp);
    }
    setIsUploading(false);
    setError("Envio cancelado pelo usuário.");
  };

  const handleReset = () => {
    setFile(null);
    setResumableSession(null);
    setProgress(null);
    setResult(null);
    setError(null);
    setIsUploading(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const isCompleted = progress?.stage === "ready" || result !== null;
  const isProcessing = progress?.stage === "processing";
  const isTransferring =
    progress?.stage === "uploading" || progress?.stage === "completing";

  return (
    <div className="w-full max-w-2xl mx-auto p-6 bg-card border border-border rounded-xl shadow-sm">
      <h2 className="text-xl font-semibold mb-4 text-card-foreground">
        Enviar Vídeo para o StreamTube
      </h2>

      {!file && (
        <div className="border-2 border-dashed border-border hover:border-primary/50 transition-colors rounded-lg p-8 text-center cursor-pointer">
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            onChange={handleFileChange}
            data-testid="video-file-input"
            className="hidden"
            id="video-upload-input"
          />
          <label
            htmlFor="video-upload-input"
            className="cursor-pointer flex flex-col items-center gap-2"
          >
            <div className="size-12 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
              📹
            </div>
            <span className="font-medium text-foreground">
              Clique para selecionar ou arraste um vídeo aqui
            </span>
            <span className="text-sm text-muted-foreground">
              Formatos suportados: MP4, WebM, MOV (máx. 10 GB)
            </span>
          </label>
        </div>
      )}

      {file && (
        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 bg-muted/30 rounded-lg border border-border">
            <div className="truncate mr-4">
              <p className="font-medium text-foreground truncate">{file.name}</p>
              <p className="text-sm text-muted-foreground">
                {formatBytes(file.size)}
              </p>
            </div>
            {!isUploading && !isCompleted && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReset}
                data-testid="change-file-btn"
              >
                Trocar arquivo
              </Button>
            )}
          </div>

          {resumableSession && !isUploading && !progress && (
            <div className="p-3 bg-primary/10 border border-primary/20 rounded-md text-sm text-primary flex items-center justify-between">
              <span>
                Envio anterior incompleto detectado (
                {resumableSession.uploadedParts.length}/
                {resumableSession.totalParts} partes concluídas).
              </span>
            </div>
          )}

          {progress && (
            <div className="space-y-2" data-testid="upload-progress">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-foreground">
                  {progress.stage === "uploading" &&
                    `Enviando partes... (${progress.uploadedPartsCount}/${progress.totalPartsCount})`}
                  {progress.stage === "completing" && "Finalizando envio..."}
                  {progress.stage === "processing" &&
                    "Processando vídeo e gerando resoluções..."}
                  {progress.stage === "ready" && "Processamento concluído!"}
                  {progress.stage === "failed" && "Falha no envio"}
                  {progress.stage === "cancelled" && "Envio cancelado"}
                </span>
                <span className="text-muted-foreground">
                  {progress.percent}%
                </span>
              </div>

              <div
                className="w-full bg-muted rounded-full h-2.5 overflow-hidden"
                role="progressbar"
                aria-valuenow={progress.percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="bg-primary h-2.5 transition-all duration-300 ease-out rounded-full"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>

              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{formatBytes(progress.loadedBytes)}</span>
                <span>{formatBytes(progress.totalBytes)}</span>
              </div>
            </div>
          )}

          {error && (
            <div
              className="p-3 bg-destructive/10 border border-destructive/20 text-destructive text-sm rounded-md"
              data-testid="upload-error"
            >
              {error}
            </div>
          )}

          {result && (
            <div
              className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-lg space-y-3"
              data-testid="upload-ready"
            >
              <div className="flex items-center gap-2 text-emerald-600 font-medium">
                <span>✓</span>
                <span>Vídeo processado e pronto para reprodução!</span>
              </div>
              <div className="flex gap-3">
                <Button asChild size="sm">
                  <Link href={`/v/${result.publicId}`}>
                    Assistir ao vídeo
                  </Link>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReset}
                  data-testid="reset-upload-btn"
                >
                  Enviar outro vídeo
                </Button>
              </div>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            {!isUploading && !isCompleted && (
              <Button
                onClick={handleStartUpload}
                data-testid="start-upload-btn"
                className="flex-1"
              >
                {resumableSession ? "Continuar envio" : "Iniciar envio"}
              </Button>
            )}

            {isUploading && (isTransferring || isProcessing) && (
              <Button
                variant="destructive"
                onClick={handleCancel}
                data-testid="cancel-upload-btn"
                className="flex-1"
              >
                Cancelar envio
              </Button>
            )}

            {error && !isUploading && (
              <Button
                variant="outline"
                onClick={handleReset}
                data-testid="retry-reset-btn"
              >
                Recomeçar
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
