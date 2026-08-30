// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VideoUploader } from "../video-uploader";
import * as coordinator from "@/lib/uploads/upload-coordinator";

describe("VideoUploader (component unit)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders dropzone and file input in initial state", () => {
    render(<VideoUploader />);
    expect(screen.getByText("Enviar Vídeo para o StreamTube")).toBeInTheDocument();
    expect(screen.getByTestId("video-file-input")).toBeInTheDocument();
  });

  it("displays file information and start button upon selecting a file", async () => {
    render(<VideoUploader />);
    const file = new File(["dummy"], "my_cool_video.mp4", {
      type: "video/mp4",
      lastModified: 1700000000000,
    });

    const input = screen.getByTestId("video-file-input");
    await userEvent.upload(input, file);

    expect(screen.getByText("my_cool_video.mp4")).toBeInTheDocument();
    expect(screen.getByTestId("start-upload-btn")).toBeInTheDocument();
    expect(screen.getByText("Iniciar envio")).toBeInTheDocument();
  });

  it("updates progress bar and state when upload progresses", async () => {
    vi.spyOn(coordinator, "uploadVideo")
      .mockImplementation((file, options) => {
        options?.onProgress?.({
          stage: "uploading",
          loadedBytes: 5242880,
          totalBytes: 10485760,
          percent: 50,
          uploadedPartsCount: 1,
          totalPartsCount: 2,
        });

        return new Promise((resolve) => {
          setTimeout(() => {
            options?.onProgress?.({
              stage: "ready",
              loadedBytes: 10485760,
              totalBytes: 10485760,
              percent: 100,
              uploadedPartsCount: 2,
              totalPartsCount: 2,
              publicId: "pub123",
              canonicalUrl: "/v/pub123",
            });
            resolve({
              publicId: "pub123",
              canonicalUrl: "/v/pub123",
              durationSeconds: 30,
            });
          }, 50);
        });
      });

    render(<VideoUploader />);
    const file = new File(["dummy"], "video.mp4", { type: "video/mp4" });
    const input = screen.getByTestId("video-file-input");
    await userEvent.upload(input, file);

    const startBtn = screen.getByTestId("start-upload-btn");
    await userEvent.click(startBtn);

    expect(screen.getByTestId("upload-progress")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("upload-ready")).toBeInTheDocument();
    });

    expect(
      screen.getByText("Vídeo processado e pronto para reprodução!"),
    ).toBeInTheDocument();
    expect(screen.getByText("Assistir ao vídeo")).toHaveAttribute(
      "href",
      "/v/pub123",
    );
  });

  it("handles upload error and displays retry button", async () => {
    vi.spyOn(coordinator, "uploadVideo").mockRejectedValue(
      new Error("Upload limit exceeded"),
    );

    render(<VideoUploader />);
    const file = new File(["dummy"], "large.mp4", { type: "video/mp4" });
    const input = screen.getByTestId("video-file-input");
    await userEvent.upload(input, file);

    const startBtn = screen.getByTestId("start-upload-btn");
    await userEvent.click(startBtn);

    await waitFor(() => {
      expect(screen.getByTestId("upload-error")).toBeInTheDocument();
    });

    expect(screen.getByText("Upload limit exceeded")).toBeInTheDocument();
    expect(screen.getByTestId("retry-reset-btn")).toBeInTheDocument();
  });

  it("allows cancelling an in-progress upload", async () => {
    let cancelSignal: AbortSignal | undefined;
    vi.spyOn(coordinator, "uploadVideo").mockImplementation((file, options) => {
      cancelSignal = options?.signal;
      options?.onProgress?.({
        stage: "uploading",
        loadedBytes: 1000,
        totalBytes: 5000,
        percent: 20,
        uploadedPartsCount: 1,
        totalPartsCount: 5,
      });

      return new Promise((_, reject) => {
        cancelSignal?.addEventListener("abort", () => {
          reject(new Error("Upload aborted"));
        });
      });
    });

    render(<VideoUploader />);
    const file = new File(["dummy"], "video.mp4", { type: "video/mp4" });
    const input = screen.getByTestId("video-file-input");
    await userEvent.upload(input, file);

    const startBtn = screen.getByTestId("start-upload-btn");
    await userEvent.click(startBtn);

    const cancelBtn = screen.getByTestId("cancel-upload-btn");
    await userEvent.click(cancelBtn);

    await waitFor(() => {
      expect(screen.getByText("Envio cancelado.")).toBeInTheDocument();
    });
  });
});
