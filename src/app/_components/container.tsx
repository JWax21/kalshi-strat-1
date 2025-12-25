type Props = {
  children?: React.ReactNode;
};

const Container = ({ children }: Props) => {
  return (
    <div className="container mx-auto px-3 sm:px-5 min-w-0 overflow-x-auto">
      {children}
    </div>
  );
};

export default Container;
