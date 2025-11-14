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
 * RemoteAccess component - manages remote access authentication and tunnel status.
 */

import type { ReactElement } from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { getAuthStatus, getTunnelStatus, login, logout, register } from '../api/client';
import type { LoginRequest, RegisterRequest } from '../api/types';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';

type AuthMode = 'login' | 'signup';

export function RemoteAccess(): ReactElement {
  const queryClient = useQueryClient();
  const [showAuth, setShowAuth] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signalingUrl, setSignalingUrl] = useState('http://localhost:8000');

  const { data: authStatus, isLoading: authLoading } = useQuery({
    queryKey: ['auth', 'status'],
    queryFn: getAuthStatus,
    refetchInterval: 5000,
  });

  const { data: tunnelStatus } = useQuery({
    queryKey: ['tunnel', 'status'],
    queryFn: getTunnelStatus,
    refetchInterval: 5000,
    enabled: authStatus?.authenticated === true,
  });

  const registerMutation = useMutation({
    mutationFn: (request: RegisterRequest) => register(request),
    onSuccess: (data) => {
      toast.success(`Account created! Device: ${data.device_id}`);
      queryClient.invalidateQueries({ queryKey: ['auth'] });
      queryClient.invalidateQueries({ queryKey: ['tunnel'] });
      setShowAuth(false);
      setEmail('');
      setPassword('');
    },
    onError: (error: Error) => {
      toast.error(`Registration failed: ${error.message}`);
    },
  });

  const loginMutation = useMutation({
    mutationFn: (request: LoginRequest) => login(request),
    onSuccess: (data) => {
      toast.success(`Logged in! Device: ${data.device_id}`);
      queryClient.invalidateQueries({ queryKey: ['auth'] });
      queryClient.invalidateQueries({ queryKey: ['tunnel'] });
      setShowAuth(false);
      setEmail('');
      setPassword('');
    },
    onError: (error: Error) => {
      toast.error(`Login failed: ${error.message}`);
    },
  });

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      toast.success('Logged out');
      queryClient.invalidateQueries({ queryKey: ['auth'] });
      queryClient.invalidateQueries({ queryKey: ['tunnel'] });
    },
    onError: (error: Error) => {
      toast.error(`Logout failed: ${error.message}`);
    },
  });

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (authMode === 'signup') {
      registerMutation.mutate({ email, password, signaling_url: signalingUrl });
    } else {
      loginMutation.mutate({ email, password, signaling_url: signalingUrl });
    }
  };

  if (authLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Remote Access</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  const isAuthenticated = authStatus?.authenticated === true;
  const connectionStatus = tunnelStatus?.mode || authStatus?.tunnel_status || 'offline';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Remote Access</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">

        {!isAuthenticated ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Badge variant="secondary" className="h-3 w-3 rounded-full p-0" />
              <span className="text-sm text-muted-foreground">Not connected</span>
            </div>

            {!showAuth ? (
              <div className="flex gap-3">
                <Button
                  onClick={() => {
                    setAuthMode('login');
                    setShowAuth(true);
                  }}
                >
                  Login
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setAuthMode('signup');
                    setShowAuth(true);
                  }}
                >
                  Sign Up
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="flex gap-2 p-1 bg-muted rounded-md">
                  <button
                    type="button"
                    onClick={() => setAuthMode('login')}
                    className={cn(
                      "flex-1 py-1.5 px-3 text-sm font-medium rounded transition-colors",
                      authMode === 'login'
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Login
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthMode('signup')}
                    className={cn(
                      "flex-1 py-1.5 px-3 text-sm font-medium rounded transition-colors",
                      authMode === 'signup'
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Sign Up
                  </button>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="signaling-url">Signaling Server</Label>
                  <Input
                    id="signaling-url"
                    type="text"
                    value={signalingUrl}
                    onChange={(e) => setSignalingUrl(e.target.value)}
                    placeholder="http://localhost:8000"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="user@example.com"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                  />
                </div>

                <div className="flex gap-3">
                  <Button
                    type="submit"
                    disabled={loginMutation.isPending || registerMutation.isPending}
                  >
                    {authMode === 'signup'
                      ? (registerMutation.isPending ? 'Creating account...' : 'Sign Up')
                      : (loginMutation.isPending ? 'Logging in...' : 'Login')
                    }
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setShowAuth(false);
                      setEmail('');
                      setPassword('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className={cn(
                  "h-3 w-3 rounded-full",
                  connectionStatus === 'connected' && "bg-green-500",
                  connectionStatus === 'connecting' && "bg-primary animate-pulse",
                  connectionStatus === 'offline' && "bg-muted-foreground",
                  connectionStatus === 'failed' && "bg-destructive"
                )} />
                <span className="text-sm">
                  {connectionStatus === 'connected' && 'Connected'}
                  {connectionStatus === 'connecting' && 'Connecting...'}
                  {connectionStatus === 'offline' && 'Offline'}
                  {connectionStatus === 'failed' && 'Connection Failed'}
                </span>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center rounded-md border border-input bg-muted/50 px-4 py-3">
                  <span className="text-sm text-muted-foreground">Email</span>
                  <span className="text-sm">{authStatus.email}</span>
                </div>
                <div className="flex justify-between items-center rounded-md border border-input bg-muted/50 px-4 py-3">
                  <span className="text-sm text-muted-foreground">Device ID</span>
                  <code className="text-sm font-mono bg-background px-2 py-1 rounded border border-border">
                    {authStatus.device_id}
                  </code>
                </div>
                {tunnelStatus?.connection_state && (
                  <div className="flex justify-between items-center rounded-md border border-input bg-muted/50 px-4 py-3">
                    <span className="text-sm text-muted-foreground">Connection</span>
                    <span className="text-sm">{tunnelStatus.connection_state}</span>
                  </div>
                )}
              </div>
            </div>

            <Button
              variant="destructive"
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
            >
              {logoutMutation.isPending ? 'Logging out...' : 'Logout'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
