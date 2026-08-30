// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { describe, expect, it, vi } from "vitest"

import { server } from "@/mocks/server"
import { ResetPasswordForm } from "../reset-password-form"

function envelope(statusCode: number, message: string) {
  return { statusCode, error: "INVALID_TOKEN", message, code: null }
}

async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("New password"), "NewPassword1!")
  await user.type(
    screen.getByLabelText("Confirm new password"),
    "NewPassword1!"
  )
}

describe("<ResetPasswordForm /> wiring", () => {
  it("submits the token and new password, then renders success", async () => {
    const user = userEvent.setup()
    const received: Record<string, unknown>[] = []
    server.use(
      http.post("/api/auth/reset-password", async ({ request }) => {
        received.push((await request.json()) as Record<string, unknown>)
        return new HttpResponse(null, { status: 204 })
      })
    )

    render(<ResetPasswordForm token="token-123" />)
    await fillValid(user)
    await user.click(screen.getByRole("button", { name: "Set new password" }))

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Senha alterada!")
    )
    expect(received).toEqual([
      { token: "token-123", new_password: "NewPassword1!" },
    ])
    expect(screen.getByRole("link", { name: "Ir para o login" })).toHaveAttribute(
      "href",
      "/login"
    )
  })

  it("maps an invalid token response to a form-level alert", async () => {
    const user = userEvent.setup()
    server.use(
      http.post("/api/auth/reset-password", () =>
        HttpResponse.json(envelope(401, "Invalid or expired reset token"), {
          status: 401,
        })
      )
    )

    render(<ResetPasswordForm token="expired-token" />)
    await fillValid(user)
    await user.click(screen.getByRole("button", { name: "Set new password" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid or expired reset token"
    )
    expect(screen.getByRole("button", { name: "Set new password" })).toBeInTheDocument()
  })

  it("blocks submit when the passwords do not match", async () => {
    const user = userEvent.setup()
    const onCall = vi.fn()
    server.use(
      http.post("/api/auth/reset-password", () => {
        onCall()
        return new HttpResponse(null, { status: 204 })
      })
    )

    render(<ResetPasswordForm token="token-123" />)
    await user.type(screen.getByLabelText("New password"), "NewPassword1!")
    await user.type(screen.getByLabelText("Confirm new password"), "Different1!")
    await user.click(screen.getByRole("button", { name: "Set new password" }))

    expect(await screen.findByText("As senhas não coincidem")).toBeInTheDocument()
    expect(onCall).not.toHaveBeenCalled()
  })

  it("blocks submit when the new password is shorter than eight characters", async () => {
    const user = userEvent.setup()
    const onCall = vi.fn()
    server.use(
      http.post("/api/auth/reset-password", () => {
        onCall()
        return new HttpResponse(null, { status: 204 })
      })
    )

    render(<ResetPasswordForm token="token-123" />)
    await user.type(screen.getByLabelText("New password"), "short")
    await user.type(screen.getByLabelText("Confirm new password"), "short")
    await user.click(screen.getByRole("button", { name: "Set new password" }))

    expect(
      await screen.findByText("A senha deve ter pelo menos 8 caracteres")
    ).toBeInTheDocument()
    expect(onCall).not.toHaveBeenCalled()
  })
})
