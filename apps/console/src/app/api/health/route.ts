import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      service: 'kanakku-console',
      timestamp: new Date().toISOString(),
      uptime_seconds: process.uptime(),
    },
    { status: 200 },
  );
}
