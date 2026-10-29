'use client';
import { pushSupported, registerWorker } from '@/lib/push-client';

const flag = 'fana-store-background-alerts';
export function storeAlertsEnabledLocally() {
  try {
    return localStorage.getItem(flag) === '1';
  } catch {
    return false;
  }
}
export async function enableStoreAlerts(prompt: boolean): Promise<string> {
  if (!pushSupported())
    return 'This browser does not support background notifications. On iPhone, add the app to the Home Screen first.';
  if (Notification.permission === 'default' && prompt)
    await Notification.requestPermission();
  if (Notification.permission !== 'granted')
    return 'Allow notifications in your browser settings to use background alerts.';
  try {
    const reg = await registerWorker();
    if (!reg) return 'Could not start the notification service.';
    await navigator.serviceWorker.ready;
    const keyResponse = await fetch('/api/push/public-key', {
      cache: 'no-store',
    });
    const data = await keyResponse.json();
    if (!keyResponse.ok || !data.publicKey)
      return 'Could not get the notification key.';
    let sub = await reg.pushManager.getSubscription();
    if (sub?.options.applicationServerKey) {
      const bytes = new Uint8Array(sub.options.applicationServerKey);
      const existing = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      if (existing !== String(data.publicKey).replace(/=+$/, ''))
        return 'This browser has an old notification key. Re-enable notifications before using Store alerts.';
    }
    if (!sub) {
      const raw = atob(
        String(data.publicKey).replace(/-/g, '+').replace(/_/g, '/') +
          '='.repeat((4 - (data.publicKey.length % 4)) % 4),
      );
      const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key.buffer as ArrayBuffer,
      });
    }
    const result = await fetch('/api/store/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    if (!result.ok)
      return 'Could not register this device for Store notifications.';
    try {
      localStorage.setItem(flag, '1');
    } catch {
      /* subscription still works */
    }
    return '';
  } catch {
    return 'Could not enable background alerts. Check your connection and notification permission.';
  }
}
export async function disableStoreAlerts(): Promise<string> {
  try {
    const reg =
      'serviceWorker' in navigator
        ? await navigator.serviceWorker.getRegistration('/')
        : undefined;
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) {
      const response = await fetch('/api/store/alerts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      if (!response.ok)
        return 'Could not turn off Store alerts. Check your connection and try again.';
    }
  } catch {
    return 'Could not turn off Store alerts. Check your connection and try again.';
  }
  try {
    localStorage.removeItem(flag);
  } catch {
    /* ignored */
  }
  return '';
}
