export interface ProfileResponse {
  id: string;
  name: string;
  displayName: string;
  bio: string;
  iconId?: string;
  iconUrl?: string;
}

export interface SimplePackageResponse {
  id: string;
  name: string;
  displayName: string;
  shortDescription: string;
  tags: string[];
  logoId?: string;
  logoUrl?: string;
  currency?: string;
  price?: number;
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
  logoId?: string;
  logoUrl?: string;
  screenshots: string[];
  currency?: string;
  price?: number;
  paid: boolean;
  owned: boolean;
  owner: ProfileResponse;
}

export interface ReleaseResponse {
  id: string;
  version: string;
  title: string;
  description: string;
  targetVersion?: string;
  fileId?: string;
  fileUrl?: string;
}

export interface AcquirePackageResponse {
  package: SimplePackageResponse;
  latestRelease?: ReleaseResponse;
}

export interface FileResponse {
  id: string;
  name: string;
  contentType: string;
  downloadUrl: string;
  size: bigint;
  sha256?: string;
}
