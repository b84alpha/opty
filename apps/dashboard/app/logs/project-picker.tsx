"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

type Props = {
  projects: { id: string; name: string }[];
  selectedId?: string;
};

export default function ProjectPicker({ projects, selectedId }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const onChange = (id: string) => {
    const params = new URLSearchParams(searchParams?.toString());
    params.set("projectId", id);
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <select
      className="select"
      value={selectedId || ""}
      onChange={(e) => onChange(e.target.value)}
      disabled={projects.length === 0}
    >
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  );
}
