import { Metadata } from "next";
import { VideoUploader } from "@/components/videos/video-uploader";

export const metadata: Metadata = {
  title: "Upload de Vídeo - StreamTube Studio",
  description: "Faça upload e gerencie seus vídeos no StreamTube Studio",
};

export default function StudioUploadPage() {
  return (
    <main className="min-h-screen py-12 px-4 bg-background">
      <div className="container mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            StreamTube Studio
          </h1>
          <p className="text-muted-foreground">
            Envie arquivos de vídeo para processamento automático e publicação.
          </p>
        </div>

        <VideoUploader />
      </div>
    </main>
  );
}
