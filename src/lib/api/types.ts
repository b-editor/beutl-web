export interface ProfileResponse {
  id: string;
  name: string;
  displayName: string;
  bio: string;
  iconId: string | null;
  iconUrl: string | null;
}

export interface SimplePackageResponse {
  id: string;
  name: string;
  displayName: string;
  shortDescription: string;
  tags: string[];
  logoId: string | null;
  logoUrl: string | null;
  currency: string | null;
  price: number | null;
  owned: boolean;
  paied: boolean;
  owner: ProfileResponse;
}

export interface PackageResponse {
  id: string;
  name: string;
  displayName: string;
  description: string;
  shortDescription: string;
  website: string;
  tags: string[];
  logoId: string | null;
  logoUrl: string | null;
  screenshots: string[];
  currency: string | null;
  price: number | null;
  paid: boolean;
  owned: boolean;
  owner: ProfileResponse;
}

export interface ReleaseResponse {
  id: string;
  version: string;
  title: string;
  description: string;
  targetVersion: string | null;
  fileId: string | null;
  fileUrl: string | null;
}

export interface AcquirePackageResponse {
  package: SimplePackageResponse;
  latestRelease: ReleaseResponse | null;
}

export interface FileResponse {
  id: string;
  name: string;
  contentType: string;
  downloadUrl: string;
  size: bigint;
  sha256: string | null;
}
