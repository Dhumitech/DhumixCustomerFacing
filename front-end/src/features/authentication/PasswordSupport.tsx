export const PASSWORD_SUPPORT_EMAIL = "dhumitechnologies@gmail.com";

export function PasswordSupport() {
  return (
    <p className="auth-password-help">
      Forgot your password? Contact{" "}
      <a href={`mailto:${PASSWORD_SUPPORT_EMAIL}`}>{PASSWORD_SUPPORT_EMAIL}</a>.
    </p>
  );
}
