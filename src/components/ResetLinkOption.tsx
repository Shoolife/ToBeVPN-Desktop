import { t } from "../i18n";
import "../screens/RouterScreen.css";

/**
 * "Reset the subscription link" when a device leaves the account: on by
 * default, so a device that is no longer trusted cannot keep using the link.
 */
export default function ResetLinkOption({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="reset-link-option">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="reset-link-option__text">
        <span className="reset-link-option__title">{t("reset_link_option")}</span>
        <span className="reset-link-option__hint">
          {checked ? t("reset_link_option_on") : t("reset_link_option_off")}
        </span>
      </span>
    </label>
  );
}
