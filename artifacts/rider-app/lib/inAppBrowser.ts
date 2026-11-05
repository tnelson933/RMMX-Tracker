import * as WebBrowser from "expo-web-browser";

/**
 * Opens a web page in a browser sheet over RM Roost (Safari View Controller on
 * iPhone, a Chrome Custom Tab on Android), so riders close it and are right
 * back where they were, instead of being sent off to Safari or Chrome.
 */
export async function openInApp(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  try {
    await WebBrowser.openBrowserAsync(url, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      controlsColor: "#B30000",
      toolbarColor: "#242424",
      enableBarCollapsing: true,
      showTitle: true,
    });
  } catch {
    /* nothing to do: the rider stays where they were */
  }
}
