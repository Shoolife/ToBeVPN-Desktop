import { t } from "../i18n";
import brandLogo from "../../src-tauri/icons/source.svg";
import "./OnboardingScreen.css";

export default function OnboardingScreen({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="onboarding-root">
      <img className="onboarding-logo" src={brandLogo} alt="" aria-hidden="true" />

      <div className="onboarding-title">ToBeVPN</div>
      <div className="onboarding-subtitle">{t("onboarding_subtitle")}</div>

      <div className="onboarding-features">
        <div>{t("onboarding_feature_trial")}</div>
        <div>{t("onboarding_feature_device")}</div>
        <div>{t("onboarding_feature_auth")}</div>
        <div>{t("onboarding_feature_tools")}</div>
      </div>

      <button className="cta-pill onboarding-continue" type="button" onClick={onContinue}>
        {t("onboarding_continue")}
      </button>
    </div>
  );
}
