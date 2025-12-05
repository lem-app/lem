// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025 Lem
//
// This file is part of Lem.
//
// Lem is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Lem is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General
// Public License for more details.

/**
 * API type definitions for signaling server communication.
 */

/**
 * JWT token response from auth endpoints.
 */
export interface Token {
  access_token: string
}

/**
 * User login credentials.
 */
export interface UserLogin {
  email: string
  password: string
}

/**
 * User registration data.
 */
export interface UserRegister {
  email: string
  password: string
}

/**
 * Device information.
 */
export interface Device {
  id: string
  user_id: number
  pubkey: string
  created_at: string
}

/**
 * WebRTC signaling message types.
 */
export type SignalingMessageType =
  | 'offer'
  | 'answer'
  | 'ice-candidate'
  | 'connected'
  | 'ack'
  | 'error'
  | 'connect-request'
  | 'connect-request-received'
  | 'connect-ack'
  | 'connect-ack-received'

/**
 * Base signaling message structure.
 */
export interface BaseSignalingMessage {
  type: SignalingMessageType
}

/**
 * SDP offer/answer payload.
 */
export interface SDPPayload {
  sdp: string
  type: 'offer' | 'answer'
}

/**
 * ICE candidate payload.
 */
export interface ICECandidatePayload {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
}

/**
 * SDP offer message.
 */
export interface OfferMessage extends BaseSignalingMessage {
  type: 'offer'
  target_device_id: string
  payload: SDPPayload
}

/**
 * SDP answer message.
 */
export interface AnswerMessage extends BaseSignalingMessage {
  type: 'answer'
  target_device_id: string
  payload: SDPPayload
}

/**
 * ICE candidate message.
 */
export interface ICECandidateMessage extends BaseSignalingMessage {
  type: 'ice-candidate'
  target_device_id: string
  payload: ICECandidatePayload
}

/**
 * ICE server configuration from signaling server.
 */
export interface ICEServerConfig {
  urls: string | string[]
  username?: string
  credential?: string
}

/**
 * Connection confirmation message.
 */
export interface ConnectedMessage extends BaseSignalingMessage {
  type: 'connected'
  device_id: string
  message: string
  ice_servers?: ICEServerConfig[]
}

/**
 * Acknowledgment message.
 */
export interface AckMessage extends BaseSignalingMessage {
  type: 'ack'
  message: string
}

/**
 * Error message.
 */
export interface ErrorMessage extends BaseSignalingMessage {
  type: 'error'
  message: string
}

/**
 * Connection request message (browser → signaling).
 */
export interface ConnectRequestMessage extends BaseSignalingMessage {
  type: 'connect-request'
  target_device_id: string
  preferred_transport?: 'webrtc' | 'relay' | 'auto'
  relay_session_id?: string
}

/**
 * Connection request notification (signaling → server).
 */
export interface ConnectRequestReceivedMessage extends BaseSignalingMessage {
  type: 'connect-request-received'
  from_device_id: string
  preferred_transport: 'webrtc' | 'relay' | 'auto'
  relay_session_id?: string
  relay_url?: string
}

/**
 * Connection acknowledgment (server → signaling).
 */
export interface ConnectAckMessage extends BaseSignalingMessage {
  type: 'connect-ack'
  target_device_id: string
  transport: 'webrtc' | 'relay'
  relay_session_id?: string
  status: 'connecting' | 'connected' | 'failed'
}

/**
 * Connection acknowledgment notification (signaling → browser).
 */
export interface ConnectAckReceivedMessage extends BaseSignalingMessage {
  type: 'connect-ack-received'
  from_device_id: string
  transport: 'webrtc' | 'relay'
  relay_session_id?: string
  status: 'connecting' | 'connected' | 'failed'
}

/**
 * Received signaling message (includes sender info).
 */
export interface ReceivedOfferMessage extends OfferMessage {
  sender_device_id: string
}

export interface ReceivedAnswerMessage extends AnswerMessage {
  sender_device_id: string
}

export interface ReceivedICECandidateMessage extends ICECandidateMessage {
  sender_device_id: string
}

/**
 * Union type for all signaling messages.
 */
export type SignalingMessage =
  | OfferMessage
  | AnswerMessage
  | ICECandidateMessage
  | ConnectedMessage
  | AckMessage
  | ErrorMessage
  | ConnectRequestMessage
  | ConnectAckMessage

/**
 * Union type for received signaling messages.
 */
export type ReceivedSignalingMessage =
  | ReceivedOfferMessage
  | ReceivedAnswerMessage
  | ReceivedICECandidateMessage
  | ConnectedMessage
  | AckMessage
  | ErrorMessage
  | ConnectRequestReceivedMessage
  | ConnectAckReceivedMessage

/**
 * WebRTC connection state.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'failed' | 'closed'

/**
 * DataChannel state.
 */
export type DataChannelState = 'connecting' | 'open' | 'closing' | 'closed' | 'none'

/**
 * Connection mode.
 */
export type ConnectionMode = 'webrtc' | 'relay'

// =============================================================================
// Service Catalog Types (for local server API)
// =============================================================================

/**
 * Service category from Harbor catalog.
 */
export type ServiceCategory = 'backend' | 'frontend' | 'satellite'

/**
 * Service runtime status.
 */
export type ServiceStatus = 'not_installed' | 'stopped' | 'running' | 'error'

/**
 * Service from the catalog with runtime status.
 */
export interface Service {
  id: string
  name: string
  category: ServiceCategory
  description: string
  status: ServiceStatus
  host_port: number | null
  endpoint: string | null
  tags: string[]
  depends_on: string[]
  has_api: boolean
  has_ui: boolean
}

/**
 * Job status for async operations.
 */
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed'

/**
 * Job type.
 */
export type JobType = 'install' | 'remove' | 'pull_model'

/**
 * Background job for tracking async operations.
 */
export interface Job {
  id: string
  type: JobType
  service_id: string
  status: JobStatus
  progress: number
  message: string
  error: string | null
  created_at: string
  updated_at: string
}

/**
 * Response from install/remove operations.
 */
export interface JobResponse {
  job_id: string
}

/**
 * Standard status response.
 */
export interface StatusResponse {
  status: 'ok'
}
