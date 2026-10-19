/** Contratos de la API de proyectoXP (espejo de src/models del backend). */

export type Role = 'USER' | 'ADMIN';

export type ReservationStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'IN_PROGRESS'
  | 'CANCELLED'
  | 'COMPLETED';

export interface UserResponse {
  id: number;
  email: string;
  name: string;
  role: Role;
  balance: number;
}

export interface LoginResponse {
  user: UserResponse;
  token: string;
}

export interface RoomResponse {
  id: number;
  name: string;
  description: string | null;
  capacity: number;
  hourlyRate: number;
  available: boolean;
}

export interface ReservationResponse {
  id: number;
  userId: number;
  roomId: number;
  startDate: string;
  endDate: string;
  status: ReservationStatus;
  totalCost: number;
}

export interface AvailabilityResponse {
  roomId: number;
  isAvailable: boolean;
}

export interface HealthResponse {
  status: string;
  timestamp: string;
}

/** Todos los errores del backend usan esta forma: `{ error: string }`. */
export interface ApiErrorBody {
  error: string;
}
