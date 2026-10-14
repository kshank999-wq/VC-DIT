/** The release build's licensing configuration (docs/DEPLOYMENT.md); empty in a developer build. */
interface ImportMetaEnv {
  readonly MAIN_VITE_SITE_URL?: string;
  readonly MAIN_VITE_LICENSE_PUBLIC_KEY?: string;
  /** Where "Send to VC Film Studio" posts the day; vcfilmstudio.com when unset. */
  readonly MAIN_VITE_FILM_STUDIO_URL?: string;
  /** Frame.io sign-in: an Adobe Developer Console OAuth Native App credential with the Frame.io API. Unset: no Frame.io. */
  readonly MAIN_VITE_FRAMEIO_CLIENT_ID?: string;
  /** That credential's redirect URI (adobe+…://… as Adobe assigns it, or a loopback http://127.0.0.1:port/…). */
  readonly MAIN_VITE_FRAMEIO_REDIRECT_URI?: string;
  /** Scopes asked for; Frame.io's SDK defaults when unset. */
  readonly MAIN_VITE_FRAMEIO_SCOPES?: string;
}
