/** Usuario virtual: una "persona" con sesión, saldo y conocimiento propio. */

import type { ApiClient } from '../api/client.js';
import type { LoginResponse, ReservationResponse, UserResponse } from '../api/types.js';
import type { Persona } from './personas.js';
import { credenciales, loginBody } from './personas.js';

export class VirtualUser {
  private token: string | null = null;
  /** Perfil cacheado (la API no tiene "saldo" aparte: sale de /users/me). */
  perfil: UserResponse | null = null;

  constructor(
    readonly persona: Persona,
    private readonly api: ApiClient,
  ) {}

  get id(): number {
    if (!this.perfil) throw new Error(`Usuario ${this.persona.email} sin sesión`);
    return this.perfil.id;
  }

  get saldo(): number {
    return this.perfil?.balance ?? 0;
  }

  requerirToken(): string {
    if (!this.token) throw new Error(`Usuario ${this.persona.email} sin token`);
    return this.token;
  }

  async register(): Promise<void> {
    this.perfil = await this.api.post<UserResponse>(
      '/api/users/register',
      credenciales(this.persona),
    );
  }

  async login(): Promise<void> {
    const respuesta = await this.api.post<LoginResponse>(
      '/api/users/login',
      loginBody(this.persona),
    );
    this.token = respuesta.token;
    this.perfil = respuesta.user;
  }

  /** Login solo si no hay token vigente (el JWT del backend dura 1 hora). */
  async ensureSession(): Promise<void> {
    if (!this.token) await this.login();
  }

  async refreshProfile(): Promise<void> {
    await this.ensureSession();
    this.perfil = await this.api.get<UserResponse>('/api/users/me', {
      token: this.requerirToken(),
    });
  }

  /** Recarga de saldo al propio usuario (dueño o ADMIN, HU-02 + HU-09). */
  async topUp(amount: number): Promise<void> {
    await this.ensureSession();
    this.perfil = await this.api.post<UserResponse>(
      `/api/users/${this.id}/balance`,
      { amount },
      { token: this.requerirToken() },
    );
  }

  /** Revoca el token actual (HU-11): la siguiente petición con él dará 401. */
  async logout(): Promise<void> {
    await this.api.post<void>('/api/users/logout', undefined, {
      token: this.requerirToken(),
    });
    this.token = null;
  }

  async myReservations(): Promise<ReservationResponse[]> {
    await this.ensureSession();
    return this.api.get<ReservationResponse[]>(`/api/users/${this.id}/reservations`, {
      token: this.requerirToken(),
    });
  }
}
