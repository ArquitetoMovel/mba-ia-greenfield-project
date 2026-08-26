"use client"

import * as React from "react"
import Link from "next/link"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { z } from "zod"

import { FieldError } from "@/components/auth/field-error"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { ApiErrorEnvelope } from "@/lib/api/contracts"
import { mapResetPasswordErrorToForm } from "@/lib/auth/error-mapping"
import { cn } from "@/lib/utils"

const resetPasswordSchema = z
  .object({
    new_password: z
      .string()
      .min(8, "A senha deve ter pelo menos 8 caracteres")
      .max(128, "A senha deve ter no máximo 128 caracteres"),
    confirm_password: z.string().min(1, "Confirme sua senha"),
  })
  .refine((values) => values.new_password === values.confirm_password, {
    path: ["confirm_password"],
    message: "As senhas não coincidem",
  })

type ResetPasswordValues = z.infer<typeof resetPasswordSchema>

type ResetPasswordFormProps = React.ComponentProps<"form"> & {
  token: string
}

function ResetPasswordForm({ token, className, ...props }: ResetPasswordFormProps) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { new_password: "", confirm_password: "" },
  })

  const [reset, setReset] = React.useState(false)

  async function onSubmit(values: ResetPasswordValues) {
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        new_password: values.new_password,
      }),
    })

    if (!res.ok) {
      const envelope = (await res.json()) as ApiErrorEnvelope
      mapResetPasswordErrorToForm(envelope, setError)
      return
    }

    setReset(true)
  }

  if (reset) {
    return (
      <div
        data-slot="reset-password-success"
        role="status"
        className={cn(
          "flex w-full flex-col items-center gap-2 text-center",
          className
        )}
      >
        <p className="text-label-lg text-foreground">Senha alterada!</p>
        <p className="text-body-md text-muted-foreground">
          Sua senha foi atualizada. Agora você já pode entrar na sua conta.
        </p>
        <Link
          href="/login"
          className="text-link hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded-[var(--radius-0-5)]"
        >
          Ir para o login
        </Link>
      </div>
    )
  }

  return (
    <form
      data-slot="reset-password-form"
      noValidate
      onSubmit={handleSubmit(onSubmit)}
      className={cn("flex w-full flex-col gap-4", className)}
      {...props}
    >
      {errors.root?.serverError?.message && (
        <p
          role="alert"
          className="text-caption text-destructive"
          data-slot="form-error"
        >
          {errors.root.serverError.message}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          placeholder="Enter your new password"
          aria-invalid={!!errors.new_password}
          {...register("new_password")}
        />
        <FieldError message={errors.new_password?.message} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          placeholder="Confirm your new password"
          aria-invalid={!!errors.confirm_password}
          {...register("confirm_password")}
        />
        <FieldError message={errors.confirm_password?.message} />
      </div>

      <Button type="submit" size="md" disabled={isSubmitting} className="w-full">
        {isSubmitting ? "Saving…" : "Set new password"}
      </Button>
    </form>
  )
}

export { ResetPasswordForm }
