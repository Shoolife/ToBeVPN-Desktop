import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[app] render crashed:", error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="screen app-error">
        <div className="app-error__card">
          <div className="app-error__title">ToBeVPN</div>
          <div className="app-error__text">
            {t("servers_load_error")}
          </div>
          <div className="app-error__details">
            {this.state.error.message || "Unknown error"}
          </div>
          <button className="cta-pill" onClick={this.handleReload}>
            {t("language_restart_button")}
          </button>
        </div>
      </div>
    );
  }
}
