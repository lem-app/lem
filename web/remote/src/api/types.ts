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
 * Connection confirmation message.
 */
export interface ConnectedMessage extends BaseSignalingMessage {
  type: 'connected'
  device_id: string
  message: string
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

/**
 * WebRTC connection state.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'failed' | 'closed'

/**
 * DataChannel state.
 */
export type DataChannelState = 'connecting' | 'open' | 'closing' | 'closed' | 'none'
