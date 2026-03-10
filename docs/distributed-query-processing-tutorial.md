# IS2209 – Data Management and Governance

## Tutorial 11 – Distributed Query Processing

## Global relations

- **Students**(Student_ID, Student_Name, Email, GPA, Department, Campus)
- **Courses**(Course_ID, Course_Name, Credits, Department)
- **Enrollment**(Enrollment_ID, Student_ID, Course_ID, Semester, Marks)

## Data distribution

- **S1**
  - Students_CMB (Students where Campus = 'Colombo')
  - Enroll_B (Enrollment_ID, Marks)
  - Courses (replica)
- **S2**
  - Students_KDY (Students where Campus = 'Kandy')
  - Courses (primary)
- **S3**
  - Enroll_A (Enrollment_ID, Student_ID, Course_ID, Semester)

**Reconstruction rule:** Enrollment is reconstructed as Enroll_A ⋈ Enroll_B on Enrollment_ID.

## Diagram (fragmentation + vertical split)

```mermaid
flowchart LR
  subgraph S1[Site S1]
    S1SC[Students_CMB]
    S1EB[Enroll_B]
    S1C[Courses (replica)]
  end

  subgraph S2[Site S2]
    S2SK[Students_KDY]
    S2C[Courses (primary)]
  end

  subgraph S3[Site S3]
    S3EA[Enroll_A]
  end

  subgraph G[Global View]
    GS[Students]
    GC[Courses]
    GE[Enrollment]
  end

  S1SC -->|horizontal fragment| GS
  S2SK -->|horizontal fragment| GS

  S2C -->|replicated| S1C
  S2C --> GC

  S3EA -->|vertical fragment| GE
  S1EB -->|vertical fragment| GE
```

---

# PART A — Setup

## PART A — Setup

### A1) Create and populate global tables (PK + FK)

> Note: In a *real* distributed DBMS you may not physically create a single “global” table. For the tutorial, we create them so you can validate constraints + sample queries in one place.

#### Global: Students
```sql
CREATE DATABASE UniversityDB;
USE UniversityDB;

CREATE TABLE Students (
  Student_ID   VARCHAR(10) PRIMARY KEY,
  Student_Name VARCHAR(100) NOT NULL,
  Email        VARCHAR(120) NOT NULL UNIQUE,
  GPA          DECIMAL(3,2) NOT NULL CHECK (GPA BETWEEN 0.00 AND 4.00),
  Department   VARCHAR(60)  NOT NULL,
  Campus       VARCHAR(20)  NOT NULL CHECK (Campus IN ('Colombo','Kandy'))
);

INSERT INTO Students (Student_ID, Student_Name, Email, GPA, Department, Campus) VALUES
('S001','Amal Perera','amal@uni.edu',3.60,'CS','Colombo'),
('S002','Nimali Silva','nimali@uni.edu',3.85,'CS','Colombo'),
('S003','Kasun Jayasinghe','kasun@uni.edu',3.10,'IS','Colombo'),
('S004','Tharindu Fernando','tharindu@uni.edu',3.40,'CS','Kandy'),
('S005','Dilani Weerasinghe','dilani@uni.edu',3.95,'SE','Kandy'),
('S006','Sahan Kumara','sahan@uni.edu',2.90,'IS','Kandy');
```

#### Global: Courses
```sql
CREATE TABLE Courses (
  Course_ID   VARCHAR(10) PRIMARY KEY,
  Course_Name VARCHAR(120) NOT NULL,
  Credits     INT NOT NULL CHECK (Credits BETWEEN 1 AND 6),
  Department  VARCHAR(60) NOT NULL
);

INSERT INTO Courses (Course_ID, Course_Name, Credits, Department) VALUES
('C101','Database Systems',3,'CS'),
('C102','Distributed Systems',3,'CS'),
('C103','Data Structures',3,'CS'),
('C104','Operating Systems',3,'CS'),
('C105','Software Engineering',3,'SE'),
('C106','Information Systems',2,'IS');
```

#### Global: Enrollment
```sql
CREATE TABLE Enrollment (
  Enrollment_ID VARCHAR(12) PRIMARY KEY,
  Student_ID    VARCHAR(10) NOT NULL,
  Course_ID     VARCHAR(10) NOT NULL,
  Semester      VARCHAR(10) NOT NULL,
  Marks         INT CHECK (Marks BETWEEN 0 AND 100),
  CONSTRAINT fk_enroll_student FOREIGN KEY (Student_ID) REFERENCES Students(Student_ID),
  CONSTRAINT fk_enroll_course  FOREIGN KEY (Course_ID)  REFERENCES Courses(Course_ID)
);

INSERT INTO Enrollment (Enrollment_ID, Student_ID, Course_ID, Semester, Marks) VALUES
('E1001','S001','C101','2025S1',78),
('E1002','S002','C101','2025S1',92),
('E1003','S003','C102','2025S1',65),
('E1004','S004','C101','2025S1',88),
('E1005','S005','C103','2025S1',90),
('E1006','S006','C101','2025S2',71),
('E1007','S005','C101','2025S1',95),
('E1008','S001','C104','2025S1',84);
```

### A2) Create and populate site tables (fragments + replicas)

#### S1: Colombo Students (Fragment)
```sql
-- S1: Colombo students
CREATE TABLE S1_Students_CMB (
  Student_ID   VARCHAR(10) PRIMARY KEY,
  Student_Name VARCHAR(100) NOT NULL,
  Email        VARCHAR(120) NOT NULL UNIQUE,
  GPA          DECIMAL(3,2) NOT NULL CHECK (GPA BETWEEN 0.00 AND 4.00),
  Department   VARCHAR(60)  NOT NULL,
  Campus       VARCHAR(20)  NOT NULL CHECK (Campus = 'Colombo')
);

INSERT INTO S1_Students_CMB
SELECT * FROM Students WHERE Campus = 'Colombo';
```

#### S2: Kandy Students (Fragment)
```sql
-- S2: Kandy students
CREATE TABLE S2_Students_KDY (
  Student_ID   VARCHAR(10) PRIMARY KEY,
  Student_Name VARCHAR(100) NOT NULL,
  Email        VARCHAR(120) NOT NULL UNIQUE,
  GPA          DECIMAL(3,2) NOT NULL CHECK (GPA BETWEEN 0.00 AND 4.00),
  Department   VARCHAR(60)  NOT NULL,
  Campus       VARCHAR(20)  NOT NULL CHECK (Campus = 'Kandy')
);

INSERT INTO S2_Students_KDY
SELECT * FROM Students WHERE Campus = 'Kandy';
```

#### S3: Enrollment Part A (Vertical Fragment)
```sql
-- S3: Enrollment attributes (A)
CREATE TABLE S3_Enroll_A (
  Enrollment_ID VARCHAR(12) PRIMARY KEY,
  Student_ID    VARCHAR(10) NOT NULL,
  Course_ID     VARCHAR(10) NOT NULL,
  Semester      VARCHAR(10) NOT NULL
  -- In a real multi-site setup, FKs may be enforced locally or via middleware.
);

INSERT INTO S3_Enroll_A (Enrollment_ID, Student_ID, Course_ID, Semester)
SELECT Enrollment_ID, Student_ID, Course_ID, Semester FROM Enrollment;
```

#### S1: Enrollment Part B (Vertical Fragment)
```sql
-- S1: Enrollment attributes (B)
CREATE TABLE S1_Enroll_B (
  Enrollment_ID VARCHAR(12) PRIMARY KEY,
  Marks         INT NOT NULL CHECK (Marks BETWEEN 0 AND 100)
);

INSERT INTO S1_Enroll_B (Enrollment_ID, Marks)
SELECT Enrollment_ID, Marks FROM Enrollment;
```

#### S2: Courses (Primary) & S1: Courses (Replica)
```sql
-- Courses: primary at S2
CREATE TABLE S2_Courses (
  Course_ID   VARCHAR(10) PRIMARY KEY,
  Course_Name VARCHAR(120) NOT NULL,
  Credits     INT NOT NULL CHECK (Credits BETWEEN 1 AND 6),
  Department  VARCHAR(60) NOT NULL
);

INSERT INTO S2_Courses
SELECT * FROM Courses;

-- Replica at S1 (copy from S2 in real life)
CREATE TABLE S1_Courses_Replica (
  Course_ID   VARCHAR(10) PRIMARY KEY,
  Course_Name VARCHAR(120) NOT NULL,
  Credits     INT NOT NULL CHECK (Credits BETWEEN 1 AND 6),
  Department  VARCHAR(60) NOT NULL
);

INSERT INTO S1_Courses_Replica
SELECT * FROM Courses;
```

### A3) Screenshot checklist (what to capture)

- Screenshot: `SELECT COUNT(*) FROM Students;` (should be 6+)  
- Screenshot: `SELECT COUNT(*) FROM Courses;` (should be 6+)  
- Screenshot: `SELECT COUNT(*) FROM Enrollment;` (should be 6+)  
- Screenshot: `SELECT COUNT(*) FROM S1_Students_CMB;` and `S2_Students_KDY`  
- Screenshot: `SELECT COUNT(*) FROM S3_Enroll_A;` and `S1_Enroll_B`

---

# PART B — Fragmentation and Reconstruction

## B1) Fragmentation predicates

**Students_CMB (S1):**

- Predicate: Campus = 'Colombo'
- Fragment definition:

$$ Students\_CMB = \sigma_{Campus='Colombo'}(Students) $$

**Students_KDY (S2):**

- Predicate: Campus = 'Kandy'
- Fragment definition:

$$ Students\_KDY = \sigma_{Campus='Kandy'}(Students) $$

## B2) Reconstruct global Students

```sql
SELECT * FROM S1_Students_CMB
UNION ALL
SELECT * FROM S2_Students_KDY;
```

> Screenshot: results of the reconstruction query.

## B3) Reconstruct global Enrollment (from Enroll_A and Enroll_B)

```sql
SELECT
  a.Enrollment_ID,
  a.Student_ID,
  a.Course_ID,
  a.Semester,
  b.Marks
FROM S3_Enroll_A a
JOIN S1_Enroll_B b
  ON b.Enrollment_ID = a.Enrollment_ID;
```

> Screenshot: results of the Enrollment reconstruction query.

---

# PART C — Query Decomposition

## Q1
**Task:** List Student_Name and Email of students enrolled in the course **'Database Systems'** in semester **'2025S1'**.

## C1) Q1 in relational algebra (global relations)

Let:
- Students = S
- Enrollment = E
- Courses = C

Relational algebra:

$$ \pi_{Student\_Name, Email}(\sigma_{C.Course\_Name='Database\ Systems' \land E.Semester='2025S1'}(S \bowtie_{S.Student\_ID=E.Student\_ID} E \bowtie_{E.Course\_ID=C.Course\_ID} C)) $$

## C2) Push selections/projections early (optimized RA)

1) Select the course first:

$$ C' = \sigma_{Course\_Name='Database\ Systems'}(C) $$

2) Select enrollments by semester:

$$ E' = \sigma_{Semester='2025S1'}(E) $$

3) Project only needed join attributes:

$$ C'' = \pi_{Course\_ID}(C') $$

$$ E'' = \pi_{Student\_ID, Course\_ID}(E') $$

4) Join reduced relations and finally project output:

$$ Result = \pi_{Student\_Name, Email}( (\pi_{Student\_ID,Student\_Name,Email}(S)) \bowtie_{Student\_ID} (E'' \bowtie_{Course\_ID} C'') ) $$

## C3) Site-level queries for Q1

**Observation:** Q1 needs Student_Name/Email + Enrollment membership. Marks are NOT needed, so we do NOT need Enroll_B.

### Step 1 (S2): find Course_ID for 'Database Systems'

```sql
-- Run at S2 (Courses primary)
SELECT Course_ID
FROM S2_Courses
WHERE Course_Name = 'Database Systems';
```

Ship the resulting `Course_ID` value(s) to S3.

### Step 2 (S3): find Student_IDs enrolled in that course in 2025S1

```sql
-- Run at S3
SELECT DISTINCT Student_ID
FROM S3_Enroll_A
WHERE Semester = '2025S1'
  AND Course_ID IN ('C101');
```

(Replace `'C101'` with the Course_ID(s) found in Step 1.)

Ship the resulting `Student_ID` list to S1 and S2.

### Step 3 (S1): fetch Colombo student names/emails for those IDs

```sql
-- Run at S1
SELECT Student_Name, Email
FROM S1_Students_CMB
WHERE Student_ID IN ('S001','S002');
```

### Step 4 (S2): fetch Kandy student names/emails for those IDs

```sql
-- Run at S2
SELECT Student_Name, Email
FROM S2_Students_KDY
WHERE Student_ID IN ('S004','S005');
```

### Final (Coordinator): UNION the two site results

```sql
-- Coordinator / middleware step
SELECT Student_Name, Email FROM (
  SELECT Student_Name, Email FROM S1_Students_CMB WHERE Student_ID IN ('S001','S002','S004','S005')
  UNION ALL
  SELECT Student_Name, Email FROM S2_Students_KDY WHERE Student_ID IN ('S001','S002','S004','S005')
) t;
```

> Screenshots: Step 1, Step 2, Step 3, Step 4, and final UNION output.

---

# PART D — Distributed Query Processing

## Q2
**Task:** For **Colombo** campus students, calculate **AVG(Marks) per Course_ID** for semester **'2025S1'**.

Global intent:

$$ \gamma_{Course\_ID,\ AVG(Marks)}( \sigma_{Campus='Colombo' \land Semester='2025S1'}(Students \bowtie Enrollment) ) $$

Because Enrollment is split: `Enrollment = S3_Enroll_A ⋈ S1_Enroll_B`.

## D1) Distributed execution plan 1 (no semi-join)

### Plan 1 idea
Ship semester-filtered enrollment tuples from S3 to S1, then do all joins + aggregation at S1.

### Plan 1 steps
1) **S3 → S1**: ship enroll_a rows for semester 2025S1

```sql
-- Run at S3
SELECT Enrollment_ID, Student_ID, Course_ID
FROM S3_Enroll_A
WHERE Semester = '2025S1';
```

2) **S1 local**: join with Colombo students and marks, then aggregate

```sql
-- Run at S1 (after receiving the S3 result as a temp table, e.g., Temp_EnrollA_2025S1)
SELECT
  a.Course_ID,
  AVG(b.Marks) AS AvgMarks
FROM Temp_EnrollA_2025S1 a
JOIN S1_Students_CMB s
  ON s.Student_ID = a.Student_ID
JOIN S1_Enroll_B b
  ON b.Enrollment_ID = a.Enrollment_ID
GROUP BY a.Course_ID;
```

### Data shipped (Plan 1)
- **S3 → S1:** (Enrollment_ID, Student_ID, Course_ID) for Semester='2025S1'

## D2) Distributed execution plan 2 (semi-join)

### Plan 2 idea
Use a semi-join to reduce what S3 sends by filtering enrollments to only Colombo students *before* shipping back.

### Plan 2 steps
1) **S1 → S3**: ship Colombo Student_ID list

```sql
-- Run at S1
SELECT Student_ID
FROM S1_Students_CMB;
```

2) **S3 local**: filter enroll_a for those student IDs and semester, then project only what S1 needs

```sql
-- Run at S3 (after receiving S1 student IDs as Temp_CMB_Students)
SELECT Enrollment_ID, Course_ID
FROM S3_Enroll_A
WHERE Semester = '2025S1'
  AND Student_ID IN (SELECT Student_ID FROM Temp_CMB_Students);
```

3) **S3 → S1**: ship (Enrollment_ID, Course_ID) only for matching rows

4) **S1 local**: join with Enroll_B and aggregate

```sql
-- Run at S1 (after receiving as Temp_EnrollA_CMB_2025S1)
SELECT
  a.Course_ID,
  AVG(b.Marks) AS AvgMarks
FROM Temp_EnrollA_CMB_2025S1 a
JOIN S1_Enroll_B b
  ON b.Enrollment_ID = a.Enrollment_ID
GROUP BY a.Course_ID;
```

### Data shipped (Plan 2)
- **S1 → S3:** Student_IDs of Colombo students
- **S3 → S1:** (Enrollment_ID, Course_ID) only for those students in Semester='2025S1'

## D3) Choose plan with less data shipping

- **If Colombo students are a subset of all students**, Plan 2 usually ships **less** from S3 → S1 because it avoids sending enrollments for Kandy students.
- If almost all students are Colombo, Plan 1 and Plan 2 may be similar.

**Selected plan (typical case):** **Plan 2 (semi-join)**.

---

# PART E — Optimization

## Q3
**Task:** Find the **top 5 students (by GPA)** who have **at least one enrollment with Marks > 85**.

### E1) Where should the selection Marks > 85 run?

- `Marks` is stored at **S1** in **S1_Enroll_B**, so run **σ(Marks > 85)** at **S1**.

### E2) Where should ORDER BY GPA and LIMIT 5 run?

- GPA is in Students fragments at **S1** (Colombo) and **S2** (Kandy).
- “Top 5” must be computed across **both fragments**, so final `ORDER BY GPA DESC LIMIT 5` should run **globally** at a **coordinator** (or middleware), after combining candidates from both sites.

### E3) One correct distributed strategy (high-level)

1) **S1:** filter Enroll_B by Marks > 85, project Enrollment_ID
2) **S1 → S3:** ship qualifying Enrollment_IDs
3) **S3:** join to get Student_IDs, project distinct Student_ID
4) **S3 → S1 and S2:** ship Student_ID set
5) **S1 and S2:** fetch Student rows for those IDs (include GPA)
6) **Coordinator:** UNION results, ORDER BY GPA DESC, LIMIT 5

### E4) SQL (tutorial version using the simulated single DB)

```sql
-- Step 1: S1 filter marks > 85
WITH HighMarks AS (
  SELECT Enrollment_ID
  FROM S1_Enroll_B
  WHERE Marks > 85
),
-- Step 2: S3 map Enrollment_ID -> Student_ID
EligibleStudents AS (
  SELECT DISTINCT a.Student_ID
  FROM S3_Enroll_A a
  JOIN HighMarks hm
    ON hm.Enrollment_ID = a.Enrollment_ID
),
-- Step 3: pull student rows from both fragments
AllEligible AS (
  SELECT Student_ID, Student_Name, Email, GPA, Department, Campus
  FROM S1_Students_CMB
  WHERE Student_ID IN (SELECT Student_ID FROM EligibleStudents)

  UNION ALL

  SELECT Student_ID, Student_Name, Email, GPA, Department, Campus
  FROM S2_Students_KDY
  WHERE Student_ID IN (SELECT Student_ID FROM EligibleStudents)
)
SELECT *
FROM AllEligible
ORDER BY GPA DESC
FETCH FIRST 5 ROWS ONLY;
```

> If your DB doesn’t support `FETCH FIRST ... ROWS ONLY`, replace with `LIMIT 5`.

### E5) Suggest two indexes (and where)

1) **Index for Marks filtering + join key** (Site: S1)

```sql
CREATE INDEX idx_s1_enroll_b_marks_enrollment
ON S1_Enroll_B (Marks, Enrollment_ID);
```

2) **Index for GPA ordering / top-k** (Sites: S1 and S2, on their student fragments)

```sql
CREATE INDEX idx_s1_students_cmb_gpa
ON S1_Students_CMB (GPA DESC, Student_ID);

CREATE INDEX idx_s2_students_kdy_gpa
ON S2_Students_KDY (GPA DESC, Student_ID);
```

---

# Appendix — Quick validation queries (use for screenshots)

```sql
-- Validate reconstruction of Students
SELECT COUNT(*) AS ReconstructedStudents
FROM (
  SELECT * FROM S1_Students_CMB
  UNION ALL
  SELECT * FROM S2_Students_KDY
) t;

-- Validate reconstruction of Enrollment
SELECT COUNT(*) AS ReconstructedEnrollment
FROM (
  SELECT a.Enrollment_ID
  FROM S3_Enroll_A a
  JOIN S1_Enroll_B b ON b.Enrollment_ID = a.Enrollment_ID
) t;

-- Run Q1 as a single query (global-style, using global tables)
SELECT s.Student_Name, s.Email
FROM Students s
JOIN Enrollment e ON e.Student_ID = s.Student_ID
JOIN Courses c ON c.Course_ID = e.Course_ID
WHERE c.Course_Name = 'Database Systems'
  AND e.Semester = '2025S1';

-- Run Q2 as a single query (global-style, using global tables)
SELECT e.Course_ID, AVG(e.Marks) AS AvgMarks
FROM Enrollment e
JOIN Students s ON s.Student_ID = e.Student_ID
WHERE s.Campus = 'Colombo'
  AND e.Semester = '2025S1'
GROUP BY e.Course_ID;

-- Run Q3 as a single query (global-style, using global tables)
SELECT DISTINCT s.Student_ID, s.Student_Name, s.GPA, s.Campus
FROM Students s
JOIN Enrollment e ON e.Student_ID = s.Student_ID
WHERE e.Marks > 85
ORDER BY s.GPA DESC
FETCH FIRST 5 ROWS ONLY;
```
